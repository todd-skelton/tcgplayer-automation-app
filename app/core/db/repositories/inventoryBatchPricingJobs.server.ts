import type { ProcessingProgress, ProcessingSummary } from "~/core/types/pricing";
import type {
  InventoryBatchPricingJob,
  InventoryBatchPricingMode,
} from "~/features/pending-inventory/types/inventoryBatch";
import type { ServerPricingConfig } from "~/features/pricing/types/config";
import {
  asJson,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type InventoryBatchPricingJobRow = {
  id: number;
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  status: InventoryBatchPricingJob["status"];
  config: ServerPricingConfig;
  progress: ProcessingProgress | null;
  summary: ProcessingSummary | null;
  errorMessage: string | null;
  attemptCount: number;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const jobSelect = `SELECT
  id,
  batch_number AS "batchNumber",
  mode,
  status,
  config_json AS "config",
  progress_json AS "progress",
  summary_json AS "summary",
  error_message AS "errorMessage",
  attempt_count AS "attemptCount",
  claimed_by AS "claimedBy",
  claim_expires_at AS "claimExpiresAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_batch_pricing_jobs`;

export const inventoryBatchPricingJobsRepository = {
  async findLatestByBatchNumber(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<InventoryBatchPricingJob | null> {
    const row = await queryOne<InventoryBatchPricingJobRow>(
      `${jobSelect}
      WHERE batch_number = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
      [batchNumber],
      executor,
    );

    return row;
  },

  async findLatestByBatchNumbers(
    batchNumbers: number[],
    executor?: Queryable,
  ): Promise<Map<number, InventoryBatchPricingJob>> {
    if (batchNumbers.length === 0) {
      return new Map();
    }

    const rows = await query<InventoryBatchPricingJobRow>(
      `SELECT DISTINCT ON (batch_number)
        id,
        batch_number AS "batchNumber",
        mode,
        status,
        config_json AS "config",
        progress_json AS "progress",
        summary_json AS "summary",
        error_message AS "errorMessage",
        attempt_count AS "attemptCount",
        claimed_by AS "claimedBy",
        claim_expires_at AS "claimExpiresAt",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM inventory_batch_pricing_jobs
      WHERE batch_number = ANY($1::int[])
      ORDER BY batch_number, created_at DESC, id DESC`,
      [batchNumbers],
      executor,
    );

    return new Map(rows.map((row) => [row.batchNumber, row]));
  },

  async createOrReuseActiveJob(
    batchNumber: number,
    mode: InventoryBatchPricingMode,
    config: ServerPricingConfig,
  ): Promise<InventoryBatchPricingJob> {
    return withTransaction(async (client) => {
      const existing = await queryOne<InventoryBatchPricingJobRow>(
        `${jobSelect}
        WHERE batch_number = $1
          AND status IN ('queued', 'pricing')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
        [batchNumber],
        client,
      );

      if (existing) {
        return existing;
      }

      const inserted = await queryOne<InventoryBatchPricingJobRow>(
        `INSERT INTO inventory_batch_pricing_jobs (
          batch_number,
          mode,
          status,
          config_json
        ) VALUES ($1, $2, 'queued', $3::jsonb)
        RETURNING
          id,
          batch_number AS "batchNumber",
          mode,
          status,
          config_json AS "config",
          progress_json AS "progress",
          summary_json AS "summary",
          error_message AS "errorMessage",
          attempt_count AS "attemptCount",
          claimed_by AS "claimedBy",
          claim_expires_at AS "claimExpiresAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"`,
        [batchNumber, mode, asJson(config)],
        client,
      );

      if (!inserted) {
        throw new Error("Failed to create inventory batch pricing job");
      }

      await execute(
        `UPDATE inventory_batches
        SET status = 'queued',
            updated_at = NOW()
        WHERE batch_number = $1`,
        [batchNumber],
        client,
      );

      return inserted;
    });
  },

  async requeueExpiredJobs(executor?: Queryable): Promise<number> {
    const updated = await query<{ batchNumber: number }>(
      `UPDATE inventory_batch_pricing_jobs
      SET status = 'queued',
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE status = 'pricing'
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at < NOW()
      RETURNING batch_number AS "batchNumber"`,
      [],
      executor,
    );

    if (updated.length > 0) {
      await execute(
        `UPDATE inventory_batches
        SET status = 'queued',
            updated_at = NOW()
        WHERE batch_number = ANY($1::int[])`,
        [updated.map((row) => row.batchNumber)],
        executor,
      );
    }

    return updated.length;
  },

  async claimNextQueuedJob(
    workerId: string,
    leaseMs: number,
  ): Promise<InventoryBatchPricingJob | null> {
    return withTransaction(async (client) => {
      const claimed = await queryOne<InventoryBatchPricingJobRow>(
        `WITH next_job AS (
          SELECT id
          FROM inventory_batch_pricing_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE inventory_batch_pricing_jobs job
        SET status = 'pricing',
            claimed_by = $1,
            claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        FROM next_job
        WHERE job.id = next_job.id
        RETURNING
          job.id,
          job.batch_number AS "batchNumber",
          job.mode,
          job.status,
          job.config_json AS "config",
          job.progress_json AS "progress",
          job.summary_json AS "summary",
          job.error_message AS "errorMessage",
          job.attempt_count AS "attemptCount",
          job.claimed_by AS "claimedBy",
          job.claim_expires_at AS "claimExpiresAt",
          job.started_at AS "startedAt",
          job.completed_at AS "completedAt",
          job.created_at AS "createdAt",
          job.updated_at AS "updatedAt"`,
        [workerId, leaseMs],
        client,
      );

      if (!claimed) {
        return null;
      }

      await execute(
        `UPDATE inventory_batches
        SET status = 'pricing',
            updated_at = NOW()
        WHERE batch_number = $1`,
        [claimed.batchNumber],
        client,
      );

      return claimed;
    });
  },

  async heartbeat(
    jobId: number,
    workerId: string,
    leaseMs: number,
    progress?: ProcessingProgress | null,
  ): Promise<void> {
    await execute(
      `UPDATE inventory_batch_pricing_jobs
      SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          progress_json = COALESCE($4::jsonb, progress_json),
          updated_at = NOW()
      WHERE id = $1
        AND status = 'pricing'
        AND claimed_by = $2`,
      [jobId, workerId, leaseMs, progress ? asJson(progress) : null],
    );
  },

  async complete(
    jobId: number,
    summary: ProcessingSummary,
    progress?: ProcessingProgress | null,
  ): Promise<void> {
    await execute(
      `UPDATE inventory_batch_pricing_jobs
      SET status = 'completed',
          summary_json = $2::jsonb,
          progress_json = COALESCE($3::jsonb, progress_json),
          error_message = NULL,
          claim_expires_at = NULL,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1`,
      [jobId, asJson(summary), progress ? asJson(progress) : null],
    );
  },

  async fail(
    jobId: number,
    batchNumber: number,
    errorMessage: string,
    progress?: ProcessingProgress | null,
  ): Promise<void> {
    await withTransaction(async (client) => {
      await execute(
        `UPDATE inventory_batch_pricing_jobs
        SET status = 'failed',
            error_message = $2,
            progress_json = COALESCE($3::jsonb, progress_json),
            claim_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1`,
        [jobId, errorMessage, progress ? asJson(progress) : null],
        client,
      );

      await execute(
        `UPDATE inventory_batches
        SET status = 'failed',
            updated_at = NOW()
        WHERE batch_number = $1`,
        [batchNumber],
        client,
      );
    });
  },
};
