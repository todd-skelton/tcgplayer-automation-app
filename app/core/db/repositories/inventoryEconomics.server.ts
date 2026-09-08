import { createHash } from "node:crypto";
import { allocateAmountCents } from "~/features/inventory-economics/domain/money";
import type {
  FundingAdjustmentInput,
  FundingAdjustmentSummary,
  OrderExpenseInput,
  OrderExpenseSummary,
  PurchaseCostInput,
  PurchaseCostSummary,
} from "~/features/inventory-economics/types/inventoryEconomics";
import { asJson, execute, query, queryOne, withTransaction, type Queryable } from "../database.server";

interface PurchaseSeriesRow { id: string }
interface EntryIdentityRow { id: string; seriesId: string; sequence: number; requestFingerprint: string }
interface ReceiptTargetRow {
  receiptId: number;
  originalQuantity: number;
  linkedQuantity: number;
  marketValue: number | null;
  sellerKey: string | null;
}

function safeCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be nonnegative whole cents.`);
}

function normalizeReference(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error(`${label} is required and limited to 200 characters.`);
  return normalized;
}

function normalizeCurrency(value: string): string {
  const currency = value.trim();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter uppercase code.");
  return currency;
}

function normalizeDate(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a calendar date in YYYY-MM-DD format.`);
  }
  return value;
}

function normalizeInstant(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp with a UTC offset.`);
  }
  return new Date(value).toISOString();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function findRepeatedRequest(requestId: string, requestFingerprint: string, table: string, db: Queryable) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`inventory-economics:${requestId}`]);
  const repeated = await queryOne<EntryIdentityRow>(
    `SELECT id::text AS id, series_id::text AS "seriesId", sequence,
      request_fingerprint AS "requestFingerprint" FROM ${table} WHERE request_id=$1`,
    [requestId], db,
  );
  if (repeated && repeated.requestFingerprint !== requestFingerprint) {
    throw new Error("Request ID was already used for different inventory economics evidence.");
  }
  return repeated;
}

async function lockSeries(
  table: string,
  referenceColumn: string,
  sellerKey: string,
  reference: string,
  currency: string,
  db: Queryable,
): Promise<PurchaseSeriesRow> {
  await execute(
    `INSERT INTO ${table} (seller_key,${referenceColumn},currency) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [sellerKey, reference, currency], db,
  );
  const row = await queryOne<PurchaseSeriesRow>(
    `SELECT id::text AS id FROM ${table} WHERE seller_key=$1 AND ${referenceColumn}=$2 AND currency=$3 FOR UPDATE`,
    [sellerKey, reference, currency], db,
  );
  if (!row) throw new Error(`Failed to establish ${referenceColumn.replaceAll("_", " ")}.`);
  return row;
}

async function nextCorrection(
  table: string,
  seriesId: string,
  correctsEntryId: string | undefined,
  correctionReason: string | undefined,
  db: Queryable,
): Promise<{ sequence: number; correctsEntryId: string | null; reason: string | null }> {
  const current = await queryOne<{ id: string; sequence: number }>(
    `SELECT id::text AS id,sequence FROM ${table} WHERE series_id=$1 ORDER BY sequence DESC LIMIT 1`,
    [seriesId], db,
  );
  if (!current) {
    if (correctsEntryId || correctionReason) throw new Error("An initial entry cannot be a correction.");
    return { sequence: 1, correctsEntryId: null, reason: null };
  }
  if (!correctsEntryId || correctsEntryId !== current.id) {
    throw new Error(`A correction must reference the current entry ${current.id}.`);
  }
  const reason = normalizeReference(correctionReason ?? "", "Correction reason");
  return { sequence: current.sequence + 1, correctsEntryId, reason };
}

export const inventoryEconomicsRepository = {
  async recordPurchaseCost(input: PurchaseCostInput, executor?: Queryable) {
    const perform = async (db: Queryable) => {
      const requestId = normalizeReference(input.requestId, "Request ID");
      const sellerKey = normalizeReference(input.sellerKey, "Seller key");
      const purchaseReference = normalizeReference(input.purchaseReference, "Purchase reference");
      const currency = normalizeCurrency(input.currency);
      safeCents(input.totalAmountCents, "Purchase total");
      const batchNumbers = [...new Set(input.batchNumbers)].sort((a, b) => a - b);
      if (!batchNumbers.length || batchNumbers.length > 100 || batchNumbers.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new Error("Purchase costs require 1 to 100 positive batch numbers.");
      }
      const purchasedAt = normalizeDate(input.purchasedAt,"Purchase date");
      const marketObservedAt = normalizeInstant(input.marketObservedAt,"Market evidence instant");
      const explicitAllocations = (input.explicitAllocations ?? [])
        .map((value) => ({ receiptId: value.receiptId, amountCents: value.amountCents }))
        .sort((a, b) => a.receiptId - b.receiptId);
      const requestFingerprint = fingerprint({ sellerKey,purchaseReference,currency,totalAmountCents:input.totalAmountCents,
        provenance:input.provenance,source:input.source,allocationRule:input.allocationRule,batchNumbers,purchasedAt,
        marketObservedAt,correctsEntryId:input.correctsEntryId ?? null,
        correctionReason:input.correctionReason?.trim() ?? null,explicitAllocations });
      const repeated = await findRepeatedRequest(requestId, requestFingerprint, "inventory_purchase_cost_entries", db);
      if (repeated) return { entryId: repeated.id, repeated: true };
      const series = await lockSeries("inventory_purchase_cost_series", "purchase_reference", sellerKey, purchaseReference, currency, db);
      const correction = await nextCorrection(
        "inventory_purchase_cost_entries", series.id, input.correctsEntryId, input.correctionReason, db,
      );
      const receipts = await query<ReceiptTargetRow>(
        `SELECT receipt.receipt_id AS "receiptId",receipt.original_quantity AS "originalQuantity",
          SUM(link.linked_quantity)::int AS "linkedQuantity",receipt.market_value::float8 AS "marketValue",
          receipt.seller_key AS "sellerKey"
        FROM inventory_receipt_batch_links link
        JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
        WHERE link.batch_number=ANY($1::int[])
        GROUP BY receipt.receipt_id,receipt.original_quantity,receipt.market_value,receipt.seller_key
        ORDER BY receipt.receipt_id`,
        [batchNumbers], db,
      );
      if (!receipts.length) throw new Error("No receipt lots were found for the selected batches.");
      if (receipts.some((receipt) => receipt.sellerKey && receipt.sellerKey !== sellerKey)) {
        throw new Error("Purchase receipts cannot cross sellers.");
      }
      let allocations: Array<{ receiptId: number; amountCents: number; weight: number }>;
      if (input.allocationRule === "explicit") {
        const explicit = new Map((input.explicitAllocations ?? []).map((value) => [value.receiptId, value.amountCents]));
        if (explicit.size !== receipts.length || receipts.some((receipt) => !explicit.has(receipt.receiptId))) {
          throw new Error("Explicit allocations must name every selected receipt exactly once.");
        }
        allocations = receipts.map((receipt) => {
          const amountCents = explicit.get(receipt.receiptId)!;
          safeCents(amountCents, `Receipt ${receipt.receiptId} allocation`);
          return { receiptId: receipt.receiptId, amountCents, weight: amountCents };
        });
        if (allocations.reduce((sum, value) => sum + value.amountCents, 0) !== input.totalAmountCents) {
          throw new Error("Explicit receipt allocations must equal the purchase total.");
        }
      } else {
        const targets = receipts.map((receipt) => ({
          id: String(receipt.receiptId),
          weight: input.allocationRule === "quantity"
            ? receipt.linkedQuantity
            : receipt.marketValue === null ? Number.NaN : receipt.marketValue * receipt.linkedQuantity,
        }));
        if (targets.some((target) => !Number.isFinite(target.weight))) {
          throw new Error("Frozen market allocation requires market evidence for every receipt.");
        }
        const byId = new Map(allocateAmountCents(input.totalAmountCents, targets).map((value) => [value.id, value.amountCents]));
        allocations = receipts.map((receipt, index) => ({
          receiptId: receipt.receiptId,
          amountCents: byId.get(String(receipt.receiptId))!,
          weight: targets[index].weight,
        }));
      }
      const inserted = await queryOne<{ id: string }>(
        `INSERT INTO inventory_purchase_cost_entries
          (series_id,request_id,request_fingerprint,sequence,total_amount_cents,provenance,source,allocation_rule,batch_numbers,
           purchased_at,market_observed_at,corrects_entry_id,correction_reason,evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING id::text AS id`,
        [series.id,requestId,requestFingerprint,correction.sequence,input.totalAmountCents,input.provenance,input.source,
          input.allocationRule,batchNumbers,purchasedAt,
          marketObservedAt,correction.correctsEntryId,correction.reason,
          asJson({ allocationRule: input.allocationRule, batchNumbers })], db,
      );
      if (!inserted) throw new Error("Failed to record purchase cost.");
      for (const allocation of allocations) {
        await execute(
          `INSERT INTO inventory_purchase_cost_allocations
            (entry_id,receipt_id,allocated_amount_cents,allocation_weight) VALUES ($1,$2,$3,$4)`,
          [inserted.id,allocation.receiptId,allocation.amountCents,allocation.weight], db,
        );
      }
      return { entryId: inserted.id, repeated: false };
    };
    return executor ? perform(executor) : withTransaction(perform);
  },

  async recordFundingAdjustment(input: FundingAdjustmentInput, executor?: Queryable) {
    const perform = async (db: Queryable) => {
      const requestId = normalizeReference(input.requestId, "Request ID");
      const sellerKey = normalizeReference(input.sellerKey, "Seller key");
      const reference = normalizeReference(input.adjustmentReference, "Adjustment reference");
      const currency = normalizeCurrency(input.currency);
      safeCents(input.amountCents, "Funding amount");
      const effectiveAt = normalizeDate(input.effectiveAt,"Effective date");
      const purchaseReference = input.adjustmentType === "purchase_funding"
        ? normalizeReference(input.purchaseReference ?? "", "Purchase reference") : null;
      const requestFingerprint = fingerprint({ sellerKey,reference,currency,adjustmentType:input.adjustmentType,
        amountCents:input.amountCents,provenance:input.provenance,effectiveAt,purchaseReference,
        correctsEntryId:input.correctsEntryId ?? null,correctionReason:input.correctionReason?.trim() ?? null });
      const repeated = await findRepeatedRequest(requestId, requestFingerprint, "inventory_funding_entries", db);
      if (repeated) return { entryId: repeated.id, repeated: true };
      const series = await lockSeries("inventory_funding_series", "adjustment_reference", sellerKey, reference, currency, db);
      const correction = await nextCorrection("inventory_funding_entries", series.id, input.correctsEntryId, input.correctionReason, db);
      const row = await queryOne<{ id: string }>(
        `INSERT INTO inventory_funding_entries
          (series_id,request_id,request_fingerprint,sequence,adjustment_type,amount_cents,provenance,effective_at,purchase_reference,
           corrects_entry_id,correction_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text AS id`,
        [series.id,requestId,requestFingerprint,correction.sequence,input.adjustmentType,input.amountCents,input.provenance,
          effectiveAt,purchaseReference,correction.correctsEntryId,correction.reason], db,
      );
      if (!row) throw new Error("Failed to record funding adjustment.");
      return { entryId: row.id, repeated: false };
    };
    return executor ? perform(executor) : withTransaction(perform);
  },

  async recordOrderExpense(input: OrderExpenseInput, executor?: Queryable) {
    const perform = async (db: Queryable) => {
      const requestId = normalizeReference(input.requestId, "Request ID");
      const sellerKey = normalizeReference(input.sellerKey, "Seller key");
      const reference = normalizeReference(input.expenseReference, "Expense reference");
      const currency = normalizeCurrency(input.currency);
      safeCents(input.amountCents, "Expense amount");
      const orderNumbers = [...new Set(input.orderNumbers.map((value) => value.trim()).filter(Boolean))].sort();
      if (!orderNumbers.length || orderNumbers.length > 100) throw new Error("An expense must name 1 to 100 orders.");
      if (input.expenseType === "refund_settlement" && orderNumbers.length !== 1) {
        throw new Error("A refund settlement must identify exactly one order.");
      }
      const expenseAt = normalizeDate(input.expenseAt,"Expense date");
      const requestFingerprint = fingerprint({ sellerKey,reference,currency,expenseType:input.expenseType,
        amountCents:input.amountCents,provenance:input.provenance,orderNumbers,expenseAt,basis:input.basis,
        correctsEntryId:input.correctsEntryId ?? null,correctionReason:input.correctionReason?.trim() ?? null });
      const repeated = await findRepeatedRequest(requestId, requestFingerprint, "inventory_order_expense_entries", db);
      if (repeated) return { entryId: repeated.id, repeated: true };
      const knownOrders = await query<{ orderNumber: string }>(
        `SELECT order_number AS "orderNumber" FROM seller_orders
         WHERE seller_key=$1 AND order_number=ANY($2::text[])`,
        [sellerKey, orderNumbers], db,
      );
      if (knownOrders.length !== orderNumbers.length) throw new Error("Every expense order must belong to the configured seller.");
      if (input.expenseType !== "refund_settlement" && input.basis !== "additional_expense") {
        throw new Error("Only refund settlements may specify a net basis.");
      }
      const series = await lockSeries("inventory_order_expense_series", "expense_reference", sellerKey, reference, currency, db);
      const correction = await nextCorrection("inventory_order_expense_entries", series.id, input.correctsEntryId, input.correctionReason, db);
      const row = await queryOne<{ id: string }>(
        `INSERT INTO inventory_order_expense_entries
          (series_id,request_id,request_fingerprint,sequence,expense_type,amount_cents,provenance,order_numbers,expense_at,basis,
           corrects_entry_id,correction_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text AS id`,
        [series.id,requestId,requestFingerprint,correction.sequence,input.expenseType,input.amountCents,input.provenance,
          orderNumbers,expenseAt,input.basis,
          correction.correctsEntryId,correction.reason], db,
      );
      if (!row) throw new Error("Failed to record order expense.");
      return { entryId: row.id, repeated: false };
    };
    return executor ? perform(executor) : withTransaction(perform);
  },

  async listPurchaseCosts(sellerKey: string, limit = 100): Promise<PurchaseCostSummary[]> {
    return query<PurchaseCostSummary>(
      `SELECT entry.id::text AS id,entry.sequence AS version,series.purchase_reference AS "purchaseReference",series.currency,
        entry.total_amount_cents::float8 AS "totalAmountCents",entry.provenance,entry.source,
        entry.allocation_rule AS "allocationRule",entry.batch_numbers AS "batchNumbers",
        entry.purchased_at::text AS "purchasedAt",entry.recorded_at AS "recordedAt"
       FROM inventory_purchase_cost_series series
       JOIN LATERAL (SELECT * FROM inventory_purchase_cost_entries e WHERE e.series_id=series.id ORDER BY sequence DESC LIMIT 1) entry ON true
       WHERE series.seller_key=$1 ORDER BY entry.recorded_at DESC,entry.id DESC LIMIT $2`,
      [sellerKey.trim(), limit],
    );
  },

  async listFundingAdjustments(sellerKey: string, limit = 100): Promise<FundingAdjustmentSummary[]> {
    return query<FundingAdjustmentSummary>(
      `SELECT entry.id::text AS id,entry.sequence AS version,series.adjustment_reference AS "adjustmentReference",series.currency,
        entry.adjustment_type AS "adjustmentType",entry.amount_cents::float8 AS "amountCents",
        entry.provenance,entry.effective_at::text AS "effectiveAt",entry.purchase_reference AS "purchaseReference",
        entry.recorded_at AS "recordedAt"
       FROM inventory_funding_series series
       JOIN LATERAL (SELECT * FROM inventory_funding_entries e WHERE e.series_id=series.id ORDER BY sequence DESC LIMIT 1) entry ON true
       WHERE series.seller_key=$1 ORDER BY entry.effective_at DESC,entry.id DESC LIMIT $2`,
      [sellerKey.trim(), limit],
    );
  },

  async listOrderExpenses(sellerKey: string, limit = 100): Promise<OrderExpenseSummary[]> {
    return query<OrderExpenseSummary>(
      `SELECT entry.id::text AS id,entry.sequence AS version,series.expense_reference AS "expenseReference",series.currency,
        entry.expense_type AS "expenseType",entry.amount_cents::float8 AS "amountCents",entry.provenance,
        entry.order_numbers AS "orderNumbers",entry.expense_at::text AS "expenseAt",entry.basis,
        entry.recorded_at AS "recordedAt"
       FROM inventory_order_expense_series series
       JOIN LATERAL (SELECT * FROM inventory_order_expense_entries e WHERE e.series_id=series.id ORDER BY sequence DESC LIMIT 1) entry ON true
       WHERE series.seller_key=$1 ORDER BY entry.expense_at DESC,entry.id DESC LIMIT $2`,
      [sellerKey.trim(), limit],
    );
  },

  async findWorkspaceEvidence(sellerKey: string, limit = 100) {
    const seller = sellerKey.trim();
    const orders = await query<{
      id: string; orderNumber: string; orderTime: Date; currency: string; grossItemCents: number;
      orderedQuantity: number;
      grossShippingCents: number | null; grossOrderCents: number | null; platformFeeCents: number | null;
      providerNetCents: number | null; directFeeCents: number | null; refunds: Array<{ amount?: number }>;
    }>(`SELECT orders.id::text AS id,orders.order_number AS "orderNumber",orders.order_time AS "orderTime",orders.currency,
        (SELECT COALESCE(SUM(line.ordered_quantity),0)::int FROM seller_order_lines line WHERE line.order_id=orders.id) AS "orderedQuantity",
        ROUND(orders.gross_item_proceeds*100)::float8 AS "grossItemCents",
        ROUND(orders.gross_shipping_proceeds*100)::float8 AS "grossShippingCents",
        ROUND(orders.gross_order_proceeds*100)::float8 AS "grossOrderCents",
        ROUND(orders.platform_fee_amount*100)::float8 AS "platformFeeCents",
        ROUND(orders.provider_net_proceeds*100)::float8 AS "providerNetCents",
        ROUND(orders.direct_fee_amount*100)::float8 AS "directFeeCents",revision.refund_evidence AS refunds
      FROM seller_orders orders JOIN seller_order_revisions revision
        ON revision.order_id=orders.id AND revision.revision_number=orders.source_revision
      WHERE orders.seller_key=$1 ORDER BY orders.order_time DESC,orders.id DESC LIMIT $2`, [seller, limit]);
    const orderNumbers = orders.map((order) => order.orderNumber);
    const postageRows = orderNumbers.length ? await query<{
      id: string; providerIdentity: string; orderNumbers: string[]; currency: string | null; rateCents: number | null; direction: string;
      linkedSellers: string[]; linkedOrderCount: number;
    }>(`SELECT purchase.id::text AS id,
        COALESCE(purchase.easypost_shipment_id,'row:'||purchase.id::text) AS "providerIdentity",
        purchase.order_numbers AS "orderNumbers",purchase.selected_rate_currency AS currency,
        CASE WHEN purchase.selected_rate_rate~'^[0-9]+([.][0-9]{1,2})?$'
          THEN ROUND(purchase.selected_rate_rate::numeric*100)::float8 END AS "rateCents",purchase.direction,
        ARRAY(SELECT DISTINCT orders.seller_key FROM seller_orders orders WHERE orders.order_number=ANY(purchase.order_numbers)) AS "linkedSellers"
        ,(SELECT COUNT(*)::int FROM seller_orders orders WHERE orders.order_number=ANY(purchase.order_numbers)) AS "linkedOrderCount"
      FROM shipping_postage_purchases purchase
      WHERE purchase.mode='production' AND purchase.status='purchased'
        AND purchase.order_numbers && $1::text[]
      ORDER BY purchase.created_at,purchase.id LIMIT 10001`, [orderNumbers]) : [];
    const postageComplete = postageRows.length <= 10000;
    const postage = postageRows.slice(0,10000);
    const allocationRows = orders.length ? await query<{
      orderId: string; receiptId: number; quantity: number; originalQuantity: number;
      allocatedCostCents: number | null; costProvenance: "actual" | "estimated" | null;
      costCurrency: string | null;
      dispositionId: string | null; quantityCorrectionId: string | null;
    }>(`WITH latest_cost AS (
        SELECT DISTINCT ON (allocation.receipt_id) allocation.receipt_id,
          allocation.allocated_amount_cents,entry.provenance,series.currency
        FROM inventory_purchase_cost_allocations allocation
        JOIN inventory_purchase_cost_entries entry ON entry.id=allocation.entry_id
        JOIN inventory_purchase_cost_series series ON series.id=entry.series_id
        WHERE series.seller_key=$1
        ORDER BY allocation.receipt_id,entry.sequence DESC
      ) SELECT fifo.order_id::text AS "orderId",allocation.receipt_id AS "receiptId",
        allocation.allocated_quantity::int AS quantity,receipt.original_quantity::int AS "originalQuantity",
        latest_cost.allocated_amount_cents::float8 AS "allocatedCostCents",latest_cost.provenance AS "costProvenance",
        latest_cost.currency AS "costCurrency",
        allocation.disposition_id::text AS "dispositionId",allocation.quantity_correction_id::text AS "quantityCorrectionId"
      FROM inventory_fifo_lines fifo
      JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=fifo.current_revision_id
      JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
      LEFT JOIN latest_cost ON latest_cost.receipt_id=allocation.receipt_id
      WHERE allocation.receipt_id IN (
        SELECT recent_allocation.receipt_id FROM inventory_fifo_lines recent_fifo
        JOIN inventory_fifo_revision_allocations recent_allocation
          ON recent_allocation.revision_id=recent_fifo.current_revision_id
        WHERE recent_fifo.order_id=ANY($2::bigint[])
      ) LIMIT 10001`, [seller, orders.map((order) => order.id)]) : [];
    const allocationsComplete = allocationRows.length <= 10000;
    const allocations = allocationRows.slice(0,10000);
    const uncostedBatches = await query<{ batchNumber: number; sourceLabel: string; receiptCount: number }>(
      `SELECT batch.batch_number AS "batchNumber",batch.source_label AS "sourceLabel",COUNT(DISTINCT link.receipt_id)::int AS "receiptCount"
       FROM inventory_batches batch JOIN inventory_receipt_batch_links link ON link.batch_number=batch.batch_number
       JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
       LEFT JOIN inventory_purchase_cost_entries cost ON batch.batch_number=ANY(cost.batch_numbers)
       WHERE cost.id IS NULL GROUP BY batch.batch_number,batch.source_label
       HAVING BOOL_AND(receipt.seller_key IS NULL OR receipt.seller_key=$1)
       ORDER BY batch.batch_number DESC LIMIT $2`, [seller,limit],
    );
    return { orders, postage, postageComplete, allocations, allocationsComplete, uncostedBatches };
  },
};
