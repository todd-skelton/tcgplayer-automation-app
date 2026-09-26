import { execute, queryOne, withTransaction } from "~/core/db/database.server";
import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import type { InventoryPublicationPolicy } from "../types/inventoryPublication";
import {
  inventoryBatchPublicationDependencies,
  planInventoryBatchPublications,
  previewInventoryBatchPublication,
} from "./inventoryBatchPublication.server";

/** Database-only planning is atomic with the intent; external writes stay in the publication worker. */
export async function planNextQueuedIntakePublication(
  policy: InventoryPublicationPolicy,
): Promise<void> {
  await withTransaction(async (client) => {
    const run = await queryOne<{
      requestId: string;
      batchNumber: number;
      pricingJobId: string;
      sellerKey: string;
      pricingStatus: string;
    }>(
      `SELECT r.request_id AS "requestId", r.batch_number AS "batchNumber",
        r.pricing_job_id::text AS "pricingJobId", r.seller_key AS "sellerKey", j.status AS "pricingStatus"
       FROM inventory_intake_runs r JOIN inventory_batch_pricing_jobs j ON j.id = r.pricing_job_id
       WHERE r.workflow = 'publish' AND r.planning_status = 'waiting'
         AND r.next_attempt_at <= NOW() AND j.status IN ('completed', 'failed')
       ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
      [],
      client,
    );
    if (!run) return;
    await execute("SAVEPOINT intake_planning", [], client);
    try {
      await execute(
        "SELECT batch_number FROM inventory_batches WHERE batch_number = $1 FOR UPDATE",
        [run.batchNumber],
        client,
      );
      const batch = await inventoryBatchesRepository.findByBatchNumber(
        run.batchNumber,
        client,
      );
      const currentSettings =
        await inventoryPublicationSettingsRepository.get(client);
      if (
        run.pricingStatus === "failed" ||
        String(batch?.latestJob?.id) !== run.pricingJobId ||
        currentSettings.settings.continuousPricing.sellerKey.trim() !==
          run.sellerKey
      ) {
        await execute(
          `UPDATE inventory_intake_runs SET planning_status = 'needs_review',
          planning_error = 'Pricing failed, was run again, or the publication seller changed. Review this batch before publishing.' WHERE request_id = $1`,
          [run.requestId],
          client,
        );
        return;
      }
      const options = {
        policy,
        mode: "manual" as const,
        targetSellerKey: run.sellerKey,
        dependencies: inventoryBatchPublicationDependencies(client),
      };
      const preview = await previewInventoryBatchPublication(
        run.batchNumber,
        options,
      );
      if (preview.eligibleCount > 0)
        await planInventoryBatchPublications(run.batchNumber, options);
      await execute(
        `UPDATE inventory_intake_runs SET planning_status = $2, planning_error = $3 WHERE request_id = $1`,
        [
          run.requestId,
          preview.eligibleCount > 0 ? "planned" : "needs_review",
          preview.eligibleCount > 0
            ? null
            : "No eligible results. Open the batch to review pricing and publication exclusions.",
        ],
        client,
      );
    } catch (error) {
      await execute("ROLLBACK TO SAVEPOINT intake_planning", [], client);
      await execute(
        `UPDATE inventory_intake_runs SET planning_error = $2,
        planning_attempts = planning_attempts + 1,
        planning_status = CASE WHEN planning_attempts >= 2 THEN 'needs_review' ELSE 'waiting' END,
        next_attempt_at = NOW() + INTERVAL '1 minute' WHERE request_id = $1`,
        [run.requestId, error instanceof Error ? error.message : String(error)],
        client,
      );
    }
  });
}
