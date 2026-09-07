import type {
  SellerOrderCoverage,
  SellerOrderObservation,
  SellerOrderSource,
} from "~/features/seller-order-history/types/sellerOrderHistory";
import { aggregateSellerOrderLines } from "~/features/seller-order-history/domain/sellerOrderObservation";
import { inventoryFifoRepository } from "./inventoryFifo.server";
import {
  asJson,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

interface OrderRow {
  id: string;
  sourceFingerprint: string;
  sourceRevision: number;
  latestSource: SellerOrderSource;
}

interface SyncRunRow {
  id: string;
  sellerKey: string;
  source: SellerOrderSource;
  status: "running" | "complete" | "incomplete";
  searchRange: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  nextOffset: number;
  expectedTotal: number | null;
  pagesCompleted: number;
  ordersObserved: number;
  detailsRecorded: number;
  observedFrom: Date | null;
  observedThrough: Date | null;
  gaps: Array<{
    orderNumber: string;
    summary?: Omit<
      import("~/integrations/tcgplayer/client/search-seller-orders.server").SellerOrderSearchSummary,
      "buyerName"
    >;
  }>;
  error: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  updatedAt: Date;
}

const runColumns = `
  id::text AS id, seller_key AS "sellerKey", source, status,
  search_range AS "searchRange", started_at AS "startedAt",
  finished_at AS "finishedAt", next_offset AS "nextOffset",
  expected_total AS "expectedTotal", pages_completed AS "pagesCompleted",
  orders_observed AS "ordersObserved", details_recorded AS "detailsRecorded",
  observed_from AS "observedFrom", observed_through AS "observedThrough",
  gaps, error, claim_token AS "claimToken", claim_expires_at AS "claimExpiresAt",
  updated_at AS "updatedAt"`;

function iso(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

function toCoverage(row: SyncRunRow | null, sellerKey: string): SellerOrderCoverage {
  if (!row) {
    return {
      sellerKey,
      source: "tcgplayer_api",
      status: "not_started",
      ordersObserved: 0,
      detailsRecorded: 0,
      gaps: [],
    };
  }
  return {
    sellerKey: row.sellerKey,
    source: row.source,
    status: row.status,
    ...(row.searchRange ? { searchRange: row.searchRange } : {}),
    ...(iso(row.observedFrom) ? { observedFrom: iso(row.observedFrom) } : {}),
    ...(iso(row.observedThrough) ? { observedThrough: iso(row.observedThrough) } : {}),
    lastAttemptAt: row.updatedAt.toISOString(),
    ...(iso(row.finishedAt) ? { completedAt: iso(row.finishedAt) } : {}),
    ...(row.expectedTotal !== null ? { expectedTotal: row.expectedTotal } : {}),
    ordersObserved: row.ordersObserved,
    detailsRecorded: row.detailsRecorded,
    nextOffset: row.nextOffset,
    gaps: (row.gaps ?? []).map((gap) => gap.orderNumber),
    ...(row.error ? { error: row.error } : {}),
  };
}

async function findRun(id: string, executor?: Queryable): Promise<SyncRunRow | null> {
  return queryOne<SyncRunRow>(
    `SELECT ${runColumns} FROM seller_order_sync_runs WHERE id = $1`,
    [id],
    executor,
  );
}

export const sellerOrderHistoryRepository = {
  async recordObservation(
    observation: SellerOrderObservation,
    executor?: Queryable,
  ): Promise<{ changed: boolean; orderId: string; revision: number }> {
    const perform = async (db: Queryable) => {
      const existing = await queryOne<OrderRow>(
        `SELECT id::text AS id, source_fingerprint AS "sourceFingerprint",
                source_revision AS "sourceRevision", latest_source AS "latestSource"
         FROM seller_orders
         WHERE seller_key = $1 AND order_number = $2
         FOR UPDATE`,
        [observation.sellerKey, observation.orderNumber],
        db,
      );
      if (existing?.sourceFingerprint === observation.fingerprint) {
        await execute(
          `UPDATE seller_orders SET
             summary_order_time = COALESCE($3, summary_order_time),
             summary_fingerprint = COALESCE($4, summary_fingerprint),
             last_observed_at = GREATEST(last_observed_at, $2),
             detail_observed_at = CASE WHEN $5 = 'tcgplayer_api'
               THEN GREATEST(detail_observed_at, $2) ELSE detail_observed_at END,
             latest_source = CASE WHEN latest_source = 'tcgplayer_api' AND $5 = 'file_import'
               THEN latest_source ELSE $5 END
           WHERE id = $1`,
          [existing.id, observation.observedAt, observation.summaryOrderTime ?? null,
            observation.summaryFingerprint ?? null, observation.source],
          db,
        );
        return { changed: false, orderId: existing.id, revision: existing.sourceRevision };
      }
      // Imports fill history outside API coverage. They never replace a current
      // API observation because a file loaded later may describe an older state.
      if (
        existing &&
        observation.source === "file_import" &&
        existing.latestSource === "tcgplayer_api"
      ) {
        return { changed: false, orderId: existing.id, revision: existing.sourceRevision };
      }

      const revision = (existing?.sourceRevision ?? 0) + 1;
      let orderId = existing?.id;
      if (orderId) {
        await execute(
          `UPDATE seller_orders SET
             order_time = $2, summary_order_time = COALESCE($3, summary_order_time), lifecycle = $4,
             provider_status = $5, refund_status = $6, order_channel = $7,
             order_fulfillment = $8, gross_item_proceeds = $9,
             source_revision = $10, source_fingerprint = $11,
             summary_fingerprint = COALESCE($12, summary_fingerprint),
             last_observed_at = $13, detail_observed_at = $13, latest_source = $14
           WHERE id = $1`,
          [orderId, observation.orderTime, observation.summaryOrderTime ?? null,
            observation.lifecycle, observation.providerStatus,
            observation.refundStatus ?? null, observation.orderChannel ?? null,
            observation.orderFulfillment ?? null, observation.grossItemProceeds,
            revision, observation.fingerprint, observation.summaryFingerprint ?? null,
            observation.observedAt, observation.source],
          db,
        );
        await execute(`DELETE FROM seller_order_lines WHERE order_id = $1`, [orderId], db);
      } else {
        const inserted = await queryOne<{ id: string }>(
          `INSERT INTO seller_orders (
             seller_key, order_number, order_time, summary_order_time, lifecycle,
             provider_status, refund_status, order_channel, order_fulfillment,
             gross_item_proceeds, source_revision, source_fingerprint, summary_fingerprint,
             first_observed_at, last_observed_at, detail_observed_at, latest_source
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$13,$13,$14)
           RETURNING id::text AS id`,
          [observation.sellerKey, observation.orderNumber, observation.orderTime,
            observation.summaryOrderTime ?? null, observation.lifecycle,
            observation.providerStatus, observation.refundStatus ?? null,
            observation.orderChannel ?? null, observation.orderFulfillment ?? null,
            observation.grossItemProceeds, observation.fingerprint,
            observation.summaryFingerprint ?? null,
            observation.observedAt, observation.source],
          db,
        );
        if (!inserted) throw new Error("Failed to insert seller order.");
        orderId = inserted.id;
      }

      const aggregateLines = aggregateSellerOrderLines(observation.lines);
      for (const line of aggregateLines) {
        await execute(
          `INSERT INTO seller_order_lines (
             order_id, sku_id, product_id, product_name, ordered_quantity, gross_item_proceeds
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderId, line.skuId, line.productId || null, line.name,
            line.quantity, line.extendedPrice],
          db,
        );
      }
      await execute(
        `INSERT INTO seller_order_revisions (
           order_id, revision_number, source_fingerprint, source, observed_at,
           summary_order_time,
           provider_status, lifecycle, refund_status, refund_evidence, line_evidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
        [orderId, revision, observation.fingerprint, observation.source,
          observation.observedAt, observation.summaryOrderTime ?? null,
          observation.providerStatus, observation.lifecycle,
          observation.refundStatus ?? null, asJson(observation.refunds),
          asJson(observation.lines)],
        db,
      );
      await inventoryFifoRepository.enqueueOrderRevision(orderId, db);
      return { changed: true, orderId, revision };
    };
    return executor ? perform(executor) : withTransaction(perform);
  },

  async recordApiObservation(
    runId: string,
    claimToken: string,
    observation: SellerOrderObservation,
  ): Promise<{ changed: boolean; orderId: string; revision: number }> {
    return withTransaction(async (db) => {
      const owned = await queryOne<{ id: string }>(
        `SELECT id::text AS id FROM seller_order_sync_runs
         WHERE id = $1 AND claim_token = $2 AND status = 'running'
           AND claim_expires_at > NOW()
         FOR UPDATE`,
        [runId, claimToken],
        db,
      );
      if (!owned) throw new Error("Seller order sync lease was lost.");
      const result = await sellerOrderHistoryRepository.recordObservation(observation, db);
      await execute(
        `UPDATE seller_order_sync_runs SET claim_expires_at = NOW() + INTERVAL '2 minutes',
           updated_at = NOW() WHERE id = $1 AND claim_token = $2`,
        [runId, claimToken],
        db,
      );
      return result;
    });
  },

  async startOrResumeApiRun(
    sellerKey: string,
    claimToken: string,
  ): Promise<{ run: SyncRunRow; acquired: boolean }> {
    const normalized = sellerKey.trim();
    return withTransaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `seller-order-sync:${normalized}`,
      ]);
      await execute(
        `UPDATE seller_order_sync_runs SET status = 'incomplete',
           error = COALESCE(error, 'Previous sync stopped before its checkpoint.'),
           claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE seller_key = $1 AND source = 'tcgplayer_api' AND status = 'running'
           AND claim_expires_at < NOW()`,
        [normalized],
        db,
      );
      const existing = await queryOne<SyncRunRow>(
        `SELECT ${runColumns} FROM seller_order_sync_runs
         WHERE seller_key = $1 AND source = 'tcgplayer_api'
           AND status IN ('running', 'incomplete')
         FOR UPDATE`,
        [normalized],
        db,
      );
      if (existing) {
        if (existing.status === "running") return { run: existing, acquired: false };
        const resumed = await queryOne<SyncRunRow>(
          `UPDATE seller_order_sync_runs
           SET status = 'running', error = NULL, claim_token = $2,
             claim_expires_at = NOW() + INTERVAL '2 minutes', updated_at = NOW()
           WHERE id = $1 RETURNING ${runColumns}`,
          [existing.id, claimToken],
          db,
        );
        if (!resumed) throw new Error("Failed to resume seller order sync.");
        return { run: resumed, acquired: true };
      }
      const created = await queryOne<SyncRunRow>(
        `INSERT INTO seller_order_sync_runs (
           seller_key, source, status, search_range, claim_token, claim_expires_at
         ) VALUES ($1, 'tcgplayer_api', 'running', 'LastThreeMonths', $2,
           NOW() + INTERVAL '2 minutes')
         RETURNING ${runColumns}`,
        [normalized, claimToken],
        db,
      );
      if (!created) throw new Error("Failed to start seller order sync.");
      return { run: created, acquired: true };
    });
  },

  async findDetailsNeeded(
    sellerKey: string,
    summaries: Array<{ orderNumber: string; summaryFingerprint: string }>,
    staleBefore: Date,
  ): Promise<string[]> {
    if (summaries.length === 0) return [];
    const fingerprints = new Map(summaries.map((value) => [value.orderNumber, value.summaryFingerprint]));
    const rows = await query<{
      orderNumber: string; summaryFingerprint: string | null; detailObservedAt: Date;
    }>(
      `SELECT order_number AS "orderNumber", summary_fingerprint AS "summaryFingerprint",
         detail_observed_at AS "detailObservedAt"
       FROM seller_orders
       WHERE seller_key = $1 AND order_number = ANY($2::text[])`,
      [sellerKey.trim(), summaries.map((value) => value.orderNumber)],
    );
    const current = new Map(rows.map((row) => [row.orderNumber, row]));
    return summaries.flatMap(({ orderNumber }) => {
      const stored = current.get(orderNumber);
      return !stored || stored.summaryFingerprint !== fingerprints.get(orderNumber) ||
        stored.detailObservedAt < staleBefore ? [orderNumber] : [];
    });
  },

  async findApiVerifiedOrderNumbers(
    sellerKey: string,
    orderNumbers: string[],
  ): Promise<string[]> {
    if (orderNumbers.length === 0) return [];
    const rows = await query<{ orderNumber: string }>(
      `SELECT order_number AS "orderNumber" FROM seller_orders
       WHERE seller_key = $1 AND latest_source = 'tcgplayer_api'
         AND order_number = ANY($2::text[])`,
      [sellerKey.trim(), orderNumbers],
    );
    return rows.map((row) => row.orderNumber);
  },

  async saveApiProgress(input: {
    runId: string;
    claimToken: string;
    nextOffset: number;
    expectedTotal: number | null;
    pageOffset?: number;
    pageOrderCount: number;
    pageCompleted: boolean;
    detailCount: number;
    observedTimes: string[];
    gaps: SyncRunRow["gaps"];
    complete: boolean;
    orderNumbers?: string[];
  }): Promise<SellerOrderCoverage> {
    const bounds = input.observedTimes.filter((value) => Number.isFinite(Date.parse(value))).sort();
    return withTransaction(async (db) => {
      const owned = await findRun(input.runId, db);
      if (!owned || owned.status !== "running" || owned.claimToken !== input.claimToken) {
        throw new Error("Seller order sync lease was lost.");
      }
      for (const [index, orderNumber] of (input.orderNumbers ?? []).entries()) {
        await execute(
          `INSERT INTO seller_order_sync_run_orders (run_id, order_number, first_offset)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [input.runId, orderNumber, (input.pageOffset ?? input.nextOffset) + index],
          db,
        );
      }
      const unique = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM seller_order_sync_run_orders WHERE run_id = $1`,
        [input.runId], db,
      );
      const row = await queryOne<SyncRunRow>(
        `UPDATE seller_order_sync_runs SET
           next_offset = $3, expected_total = $4,
           pages_completed = pages_completed + CASE WHEN $5 THEN 1 ELSE 0 END,
           orders_observed = $6, details_recorded = details_recorded + $7,
           observed_from = CASE WHEN $8::timestamptz IS NULL THEN observed_from
             ELSE LEAST(COALESCE(observed_from, $8), $8) END,
           observed_through = CASE WHEN $9::timestamptz IS NULL THEN observed_through
             ELSE GREATEST(COALESCE(observed_through, $9), $9) END,
           gaps = $10::jsonb, error = NULL,
           claim_expires_at = NOW() + INTERVAL '2 minutes', updated_at = NOW()
         WHERE id = $1 AND claim_token = $2 AND status = 'running'
         RETURNING ${runColumns}`,
        [input.runId, input.claimToken, input.nextOffset, input.expectedTotal,
          input.pageCompleted, unique?.count ?? 0, input.detailCount,
          bounds[0] ?? null, bounds.at(-1) ?? null, asJson(input.gaps)], db,
      );
      if (!row) throw new Error("Seller order sync lease was lost.");
      return toCoverage(row, row.sellerKey);
    });
  },

  async finishApiRun(
    runId: string,
    claimToken: string,
    complete: boolean,
    message?: string,
  ): Promise<SellerOrderCoverage> {
    return withTransaction(async (db) => {
      const row = await queryOne<SyncRunRow>(
        `UPDATE seller_order_sync_runs SET status = $3,
           finished_at = CASE WHEN $3 = 'complete' THEN NOW() ELSE NULL END,
           error = $4, claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND claim_token = $2 AND status = 'running'
         RETURNING ${runColumns}`,
        [runId, claimToken, complete ? "complete" : "incomplete", message ?? null],
        db,
      );
      if (!row) throw new Error("Seller order sync lease was lost.");
      if (complete) {
        await execute(`DELETE FROM seller_order_sync_run_orders WHERE run_id = $1`, [runId], db);
        await execute(
          `DELETE FROM seller_order_sync_runs
           WHERE seller_key = $1 AND source = 'tcgplayer_api' AND status = 'complete'
             AND id NOT IN (
               SELECT id FROM seller_order_sync_runs
               WHERE seller_key = $1 AND source = 'tcgplayer_api' AND status = 'complete'
               ORDER BY finished_at DESC, id DESC LIMIT 30
             )`,
          [row.sellerKey],
          db,
        );
      }
      return toCoverage(row, row.sellerKey);
    });
  },

  async restartInconsistentApiRun(
    runId: string,
    claimToken: string,
    message: string,
  ): Promise<SellerOrderCoverage> {
    return withTransaction(async (db) => {
      const owned = await queryOne<SyncRunRow>(
        `SELECT ${runColumns} FROM seller_order_sync_runs
         WHERE id = $1 AND claim_token = $2 AND status = 'running' FOR UPDATE`,
        [runId, claimToken],
        db,
      );
      if (!owned) throw new Error("Seller order sync lease was lost.");
      await execute(`DELETE FROM seller_order_sync_run_orders WHERE run_id = $1`, [runId], db);
      const row = await queryOne<SyncRunRow>(
        `UPDATE seller_order_sync_runs SET status = 'incomplete', next_offset = 0,
           expected_total = NULL, pages_completed = 0, orders_observed = 0,
           error = $3, claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND claim_token = $2 RETURNING ${runColumns}`,
        [runId, claimToken, message],
        db,
      );
      if (!row) throw new Error("Seller order sync lease was lost.");
      return toCoverage(row, row.sellerKey);
    });
  },

  async getCoverage(sellerKey: string): Promise<SellerOrderCoverage> {
    const row = await queryOne<SyncRunRow>(
      `SELECT ${runColumns} FROM seller_order_sync_runs
       WHERE seller_key = $1 AND source = 'tcgplayer_api'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [sellerKey.trim()],
    );
    return toCoverage(row, sellerKey.trim());
  },

  async importObservations(input: {
    sellerKey: string;
    fingerprint: string;
    fileName?: string;
    observations: SellerOrderObservation[];
  }): Promise<{ recorded: boolean; importedOrders: number }> {
    return withTransaction(async (db) => {
      const claimed = await queryOne<{ id: string }>(
        `INSERT INTO seller_order_imports (
           seller_key, content_fingerprint, file_name, order_count, line_count
         ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id::text AS id`,
        [input.sellerKey, input.fingerprint, input.fileName ?? null,
          input.observations.length,
          input.observations.reduce((sum, order) => sum + order.lines.length, 0)],
        db,
      );
      if (!claimed) return { recorded: false, importedOrders: 0 };
      let importedOrders = 0;
      for (const observation of input.observations) {
        const result = await sellerOrderHistoryRepository.recordObservation(observation, db);
        if (result.changed) importedOrders += 1;
      }
      return { recorded: true, importedOrders };
    });
  },

  async findOrder(sellerKey: string, orderNumber: string) {
    const order = await queryOne<{
      id: string; sellerKey: string; orderNumber: string; orderTime: Date;
      lifecycle: string; providerStatus: string; sourceRevision: number;
      sourceFingerprint: string; latestSource: SellerOrderSource;
    }>(
      `SELECT id::text AS id, seller_key AS "sellerKey", order_number AS "orderNumber",
         order_time AS "orderTime", lifecycle, provider_status AS "providerStatus",
         source_revision AS "sourceRevision", source_fingerprint AS "sourceFingerprint",
         latest_source AS "latestSource"
       FROM seller_orders WHERE seller_key = $1 AND order_number = $2`,
      [sellerKey.trim(), orderNumber.trim()],
    );
    if (!order) return null;
    const lines = await query<{
      skuId: string; productId: string | null; orderedQuantity: number;
      grossItemProceeds: number;
    }>(
      `SELECT sku_id AS "skuId", product_id AS "productId",
         ordered_quantity AS "orderedQuantity",
         gross_item_proceeds::float8 AS "grossItemProceeds"
       FROM seller_order_lines WHERE order_id = $1 ORDER BY sku_id`,
      [order.id],
    );
    return { ...order, orderTime: order.orderTime.toISOString(), lines };
  },
};
