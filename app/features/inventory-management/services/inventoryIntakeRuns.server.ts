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
  expectedInventory: IntakeQuantity[];
  expectedSellerKey: string;
}) {
  const requestDetails = {
    workflow: input.workflow,
    purchaseCost: input.purchaseCost ?? null,
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
    if ((input.workflow === "publish" || input.purchaseCost) && !sellerKey) {
      throw new InventoryIntakeInputError(
        "Configure a default shipping seller before queuing publication or purchase cost.",
      );
    }
    let cost;
    try {
      cost = input.purchaseCost
        ? parseIntakePurchaseCost(
            input.purchaseCost,
            input.requestId,
            sellerKey,
          )
        : undefined;
    } catch (error) {
      throw new InventoryIntakeInputError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const batch = await createPendingInventoryBatchWithCost(
      input.requestId,
      cost,
      sellerKey || null,
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
  return query<InventoryIntakeRun>(`SELECT r.batch_number AS "batchNumber", r.workflow,
    r.planning_status AS "planningStatus", r.planning_error AS "planningError",
    j.status AS "pricingStatus", j.error_message AS "pricingError", r.created_at AS "createdAt",
    items.count AS "itemCount", items.quantity,
    COALESCE(p.published, 0)::int AS "publishedCount",
    COALESCE(p.publishing, 0)::int AS "publishingCount",
    CASE WHEN j.status = 'completed' THEN
      CASE WHEN r.workflow = 'price_only' OR r.planning_status = 'waiting'
        THEN b.manual_review_count + COALESCE(p.failed, 0)
        ELSE GREATEST(0, items.count - COALESCE(p.published, 0) - COALESCE(p.publishing, 0)) END
      ELSE 0 END::int AS "reviewCount"
    FROM (SELECT * FROM inventory_intake_runs ORDER BY created_at DESC LIMIT 25) r
    JOIN inventory_batches b ON b.batch_number = r.batch_number
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
}
