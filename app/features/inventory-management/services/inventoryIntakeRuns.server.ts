import { isDeepStrictEqual } from "node:util";
import {
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "~/core/db/database.server";
import {
  inventoryBatchesRepository,
  inventoryBatchPricingJobsRepository,
  pricingConfigRepository,
  pendingInventoryRepository,
  shippingExportConfigRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { InventoryBatchRequestConflictError } from "~/core/db/repositories/inventoryBatches.server";
import { createPendingInventoryBatchWithCost } from "~/features/pending-inventory/services/createPendingInventoryBatchWithCost.server";
import { parseIntakePurchaseCost } from "~/features/pending-inventory/services/intakePurchaseCost.server";
import { parseEstimatedCostRate } from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { intakeSnapshot, type IntakeQuantity } from "./intakeSnapshot";
import type {
  InventoryIntakeRun,
  InventoryIntakeWorkflow,
} from "../types/inventoryIntakeRun";

export class InventoryIntakeInputError extends Error {}

export async function getIntakePublicationTarget(executor?: Queryable) {
  const shipping = await shippingExportConfigRepository.get(executor);
  const publication =
    await inventoryPublicationSettingsRepository.get(executor);
  const sellerKey = shipping?.settings.defaultSellerKey?.trim() ?? "";
  const publicationSellerKey =
    publication.settings.continuousPricing.sellerKey.trim();
  return {
    sellerKey,
    publicationSellerKey,
    canPublish: Boolean(sellerKey && sellerKey === publicationSellerKey),
    publishingUnavailableReason: !sellerKey
      ? "Set a default shipping seller before queuing publication."
      : sellerKey !== publicationSellerKey
        ? "The publication seller and default shipping seller must match before queuing publication."
        : null,
    publicationPaused:
      publication.settings.globalPaused ||
      publication.runtime.circuitOpen ||
      publication.runtime.authenticationStatus === "invalid",
  };
}

export async function queueInventoryIntake(input: {
  requestId: string;
  workflow: InventoryIntakeWorkflow;
  purchaseCost?: Record<string, unknown>;
  /** Percent of market and amount less per card the estimated cost uses instead of the default rule. */
  estimatedCostRate?: Record<string, unknown>;
  expectedInventory: IntakeQuantity[];
  expectedSellerKey: string;
}) {
  const requestDetails = {
    workflow: input.workflow,
    purchaseCost: input.purchaseCost ?? null,
    // Kept only when given, so requests saved before cost rates existed still match on retry.
    ...(input.estimatedCostRate ? { estimatedCostRate: input.estimatedCostRate } : {}),
    expectedInventory: intakeSnapshot(input.expectedInventory),
    expectedSellerKey: input.expectedSellerKey,
  };
  return withTransaction(async (client) => {
    await execute("SELECT pg_advisory_xact_lock(55, 0)", [], client);
    const previous = await queryOne<{ batchNumber: number; details: unknown }>(
      `SELECT batch_number AS "batchNumber", request_json AS details
       FROM inventory_intake_runs WHERE request_id = $1`,
      [input.requestId],
      client,
    );
    if (previous) {
      if (!isDeepStrictEqual(previous.details, requestDetails)) {
        throw new InventoryBatchRequestConflictError(
          "This request already queued different options. Recover the original request first.",
        );
      }
      return inventoryBatchesRepository.findByBatchNumber(
        previous.batchNumber,
        client,
      );
    }
    const used = await queryOne(
      "SELECT request_id FROM inventory_batch_intake_requests WHERE request_id = $1",
      [input.requestId],
      client,
    );
    if (used)
      throw new InventoryBatchRequestConflictError(
        "This request belongs to an earlier or deleted batch.",
      );
    const current = intakeSnapshot(
      await pendingInventoryRepository.findAll(client),
    );
    if (!isDeepStrictEqual(current, requestDetails.expectedInventory)) {
      throw new InventoryBatchRequestConflictError(
        "The shared inventory queue changed. Review the refreshed quantities and queue again. No inventory was handed off.",
      );
    }
    const target = await getIntakePublicationTarget(client);
    const sellerKey = target.sellerKey;
    if (sellerKey !== input.expectedSellerKey)
      throw new InventoryBatchRequestConflictError(
        "The intake seller changed. Refresh and review the seller before queuing again.",
      );
    if (input.workflow === "publish" && !target.canPublish)
      throw new InventoryIntakeInputError(target.publishingUnavailableReason!);
    if ((input.workflow === "publish" || input.purchaseCost || input.estimatedCostRate) && !sellerKey) {
      throw new InventoryIntakeInputError(
        "Configure a default shipping seller before queuing publication or purchase cost.",
      );
    }
    if (input.purchaseCost && input.estimatedCostRate) {
      throw new InventoryIntakeInputError("Enter a purchase total or a cost rate, not both.");
    }
    let purchaseCost;
    let estimatedCostRate;
    try {
      purchaseCost = input.purchaseCost
        ? parseIntakePurchaseCost(
            input.purchaseCost,
            input.requestId,
            sellerKey,
          )
        : undefined;
      estimatedCostRate = input.estimatedCostRate
        ? parseEstimatedCostRate(input.estimatedCostRate)
        : undefined;
    } catch (error) {
      throw new InventoryIntakeInputError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const batch = await createPendingInventoryBatchWithCost(
      input.requestId,
      { purchaseCost, estimatedCostRate, estimateForSeller: sellerKey || null },
      undefined,
      client,
    );
    if (!batch)
      throw new InventoryIntakeInputError(
        "No saved inventory is available to queue.",
      );
    const config = await pricingConfigRepository.get(client);
    const job =
      await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
        batch.batchNumber,
        "full",
        config,
        client,
      );
    await execute(
      `INSERT INTO inventory_intake_runs
      (request_id, batch_number, pricing_job_id, workflow, request_json, seller_key)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        input.requestId,
        batch.batchNumber,
        job.id,
        input.workflow,
        JSON.stringify(requestDetails),
        sellerKey || null,
      ],
      client,
    );
    return inventoryBatchesRepository.findByBatchNumber(
      batch.batchNumber,
      client,
    );
  });
}

export async function findRecentInventoryIntakeRuns(): Promise<
  InventoryIntakeRun[]
> {
  const rows = await query<Omit<InventoryIntakeRun, "costRate"> & {
    costMarketRate: number | null;
    costPerUnitDeductionCents: number | null;
  }>(`SELECT r.batch_number AS "batchNumber", r.workflow,
    r.planning_status AS "planningStatus", r.planning_error AS "planningError",
    j.status AS "pricingStatus", j.error_message AS "pricingError", r.created_at AS "createdAt",
    items.count AS "itemCount", items.quantity,
    COALESCE(p.published, 0)::int AS "publishedCount",
    COALESCE(p.publishing, 0)::int AS "publishingCount",
    CASE WHEN j.status = 'completed' THEN
      CASE WHEN r.workflow = 'price_only' OR r.planning_status = 'waiting'
        THEN b.manual_review_count + COALESCE(p.failed, 0)
        ELSE GREATEST(0, items.count - COALESCE(p.published, 0) - COALESCE(p.publishing, 0)) END
      ELSE 0 END::int AS "reviewCount",
    cost.cents AS "recordedCostCents", cost.uncosted AS "uncostedLotCount", cost.entered AS "hasEnteredCost",
    rate.market_rate::float8 AS "costMarketRate", rate.per_unit_deduction_cents AS "costPerUnitDeductionCents"
    FROM (SELECT * FROM inventory_intake_runs ORDER BY created_at DESC LIMIT 25) r
    JOIN inventory_batches b ON b.batch_number = r.batch_number
    LEFT JOIN inventory_batch_estimated_cost_rates rate ON rate.batch_number = r.batch_number
    CROSS JOIN LATERAL (SELECT SUM(allocation.allocated_amount_cents)::float8 AS cents,
      COUNT(*) FILTER (WHERE ownership.receipt_id IS NULL)::int AS uncosted,
      COALESCE(bool_or(series.purchase_reference <> 'estimated:batch-' || r.batch_number), FALSE) AS entered
      FROM inventory_receipt_batch_links link
      LEFT JOIN inventory_purchase_receipt_ownership ownership ON ownership.receipt_id = link.receipt_id
      LEFT JOIN inventory_purchase_cost_series series ON series.id = ownership.series_id
      LEFT JOIN LATERAL (SELECT entry.id FROM inventory_purchase_cost_entries entry
        WHERE entry.series_id = ownership.series_id ORDER BY entry.sequence DESC LIMIT 1) current ON TRUE
      LEFT JOIN inventory_purchase_cost_allocations allocation
        ON allocation.entry_id = current.id AND allocation.receipt_id = link.receipt_id
      WHERE link.batch_number = r.batch_number) cost
    JOIN LATERAL (SELECT * FROM inventory_batch_pricing_jobs WHERE batch_number = r.batch_number ORDER BY id DESC LIMIT 1) j ON TRUE
    CROSS JOIN LATERAL (SELECT COUNT(*)::int AS count, COALESCE(SUM(add_to_quantity), 0)::int AS quantity
      FROM inventory_batch_items WHERE batch_number = r.batch_number) items
    LEFT JOIN LATERAL (SELECT
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status = 'published' AND i.quantity_delta > 0) AS published,
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status = 'planned' AND p.status IN ('planned','staging','staged','publishing')) AS publishing,
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status IN ('failed','ambiguous','manual_review') OR
        (i.status = 'planned' AND p.status IN ('failed','ambiguous','rolled_back'))) AS failed
      FROM inventory_publication_items i JOIN inventory_publications p ON p.id = i.publication_id
      WHERE i.batch_number = r.batch_number AND i.quantity_delta > 0) p ON TRUE
    ORDER BY r.created_at DESC`);
  return rows.map(({ costMarketRate, costPerUnitDeductionCents, ...run }) => ({
    ...run,
    costRate: costMarketRate === null || costPerUnitDeductionCents === null
      ? null : { marketRate: costMarketRate, perUnitDeductionCents: costPerUnitDeductionCents },
  }));
}
