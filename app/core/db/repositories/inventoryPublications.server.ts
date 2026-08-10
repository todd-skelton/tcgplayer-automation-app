import type {
  CreateInventoryPublication,
  InventoryPublication,
  InventoryPublicationItem,
  InventoryPublicationItemOutcome,
  InventoryPublicationStatus,
} from "~/features/inventory-publication/types/inventoryPublication";
import { requireInventoryPublicationTransition } from "~/features/inventory-publication/services/inventoryPublicationState";
import {
  asJson,
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type InventoryPublicationRow = Omit<InventoryPublication, "items">;
type InventoryPublicationItemRow = InventoryPublicationItem;

export interface CreateOrFindInventoryPublicationResult {
  publication: InventoryPublication;
  created: boolean;
}

const publicationSelect = `SELECT
  id,
  planning_key AS "planningKey",
  batch_number AS "batchNumber",
  pricing_job_id AS "pricingJobId",
  method,
  source_type AS "sourceType",
  seller_key AS "sellerKey",
  status,
  staged_pricing_upload_id AS "stagedPricingUploadId",
  config_json AS "config",
  progress_json AS "progress",
  error_code AS "errorCode",
  error_message AS "errorMessage",
  attempt_count AS "attemptCount",
  claimed_by AS "claimedBy",
  claim_expires_at AS "claimExpiresAt",
  staged_at AS "stagedAt",
  publishing_at AS "publishingAt",
  published_at AS "publishedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_publications`;

const publicationItemSelect = `SELECT
  id,
  publication_id AS "publicationId",
  candidate_key AS "candidateKey",
  inventory_delta_key AS "inventoryDeltaKey",
  batch_number AS "batchNumber",
  sku,
  product_id AS "productId",
  product_line AS "productLine",
  set_name AS "setName",
  product_name AS "productName",
  condition,
  previous_price::float8 AS "previousPrice",
  desired_price::float8 AS "desiredPrice",
  quantity_delta AS "quantityDelta",
  observed_quantity AS "observedQuantity",
  desired_absolute_quantity AS "desiredAbsoluteQuantity",
  priced_at AS "pricedAt",
  eligibility_reasons AS "eligibilityReasons",
  status,
  error_code AS "errorCode",
  error_message AS "errorMessage",
  published_at AS "publishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_publication_items`;

function requireNonEmptyText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RangeError(`${name} must not be empty.`);
  }
}

function validateCreateParams(params: CreateInventoryPublication): void {
  requireNonEmptyText(params.planningKey, "planningKey");

  if (params.items.length === 0) {
    throw new RangeError("items must contain at least one publication item.");
  }

  params.items.forEach((item, index) => {
    const prefix = `items[${index}]`;
    requireNonEmptyText(item.candidateKey, `${prefix}.candidateKey`);
    requireNonEmptyText(item.productLine, `${prefix}.productLine`);
    requireNonEmptyText(item.setName, `${prefix}.setName`);
    requireNonEmptyText(item.productName, `${prefix}.productName`);
    requireNonEmptyText(item.condition, `${prefix}.condition`);

    if (!Number.isInteger(item.sku) || item.sku <= 0) {
      throw new RangeError(`${prefix}.sku must be a positive integer.`);
    }
    if (!Number.isInteger(item.productId) || item.productId <= 0) {
      throw new RangeError(`${prefix}.productId must be a positive integer.`);
    }
    if (!Number.isInteger(item.quantityDelta)) {
      throw new RangeError(`${prefix}.quantityDelta must be an integer.`);
    }
    if (!Number.isFinite(item.desiredPrice) || item.desiredPrice <= 0) {
      throw new RangeError(`${prefix}.desiredPrice must be positive.`);
    }

    const inventoryDeltaKey = item.inventoryDeltaKey?.trim() || null;
    if (item.quantityDelta === 0 && inventoryDeltaKey) {
      throw new RangeError(
        `${prefix}.inventoryDeltaKey must be empty for a zero quantity delta.`,
      );
    }
    if (item.quantityDelta !== 0 && !inventoryDeltaKey) {
      throw new RangeError(
        `${prefix}.inventoryDeltaKey is required for a non-zero quantity delta.`,
      );
    }
  });
}

async function findItems(
  publicationId: number,
  executor?: Queryable,
): Promise<InventoryPublicationItem[]> {
  return query<InventoryPublicationItemRow>(
    `${publicationItemSelect}
    WHERE publication_id = $1
    ORDER BY id`,
    [publicationId],
    executor,
  );
}

async function attachItems(
  publication: InventoryPublicationRow,
  executor?: Queryable,
): Promise<InventoryPublication> {
  return {
    ...publication,
    items: await findItems(publication.id, executor),
  };
}

async function findByPlanningKey(
  planningKey: string,
  executor?: Queryable,
): Promise<InventoryPublication | null> {
  const publication = await queryOne<InventoryPublicationRow>(
    `${publicationSelect}
    WHERE planning_key = $1`,
    [planningKey],
    executor,
  );

  return publication ? attachItems(publication, executor) : null;
}

export const inventoryPublicationsRepository = {
  async findById(
    publicationId: number,
    executor?: Queryable,
  ): Promise<InventoryPublication | null> {
    const publication = await queryOne<InventoryPublicationRow>(
      `${publicationSelect}
      WHERE id = $1`,
      [publicationId],
      executor,
    );

    return publication ? attachItems(publication, executor) : null;
  },

  findByPlanningKey,

  async findByBatchNumber(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<InventoryPublication[]> {
    const publications = await query<InventoryPublicationRow>(
      `${publicationSelect}
      WHERE batch_number = $1
      ORDER BY created_at DESC, id DESC`,
      [batchNumber],
      executor,
    );

    return Promise.all(
      publications.map((publication) => attachItems(publication, executor)),
    );
  },

  async findExistingInventoryDeltaKeys(
    inventoryDeltaKeys: string[],
    executor?: Queryable,
  ): Promise<Set<string>> {
    if (inventoryDeltaKeys.length === 0) {
      return new Set();
    }

    const rows = await query<{ inventoryDeltaKey: string }>(
      `SELECT inventory_delta_key AS "inventoryDeltaKey"
      FROM inventory_publication_items
      WHERE inventory_delta_key = ANY($1::text[])`,
      [inventoryDeltaKeys],
      executor,
    );

    return new Set(rows.map((row) => row.inventoryDeltaKey));
  },

  async findExistingPricingCandidateKeys(
    candidateKeys: string[],
    executor?: Queryable,
  ): Promise<Set<string>> {
    if (candidateKeys.length === 0) {
      return new Set();
    }

    const rows = await query<{ candidateKey: string }>(
      `SELECT DISTINCT candidate_key AS "candidateKey"
      FROM inventory_publication_items
      WHERE candidate_key = ANY($1::text[])`,
      [candidateKeys],
      executor,
    );

    return new Set(rows.map((row) => row.candidateKey));
  },

  async findInventoryDeltaStatuses(
    inventoryDeltaKeys: string[],
    executor?: Queryable,
  ): Promise<Map<string, InventoryPublicationItem["status"]>> {
    if (inventoryDeltaKeys.length === 0) {
      return new Map();
    }

    const rows = await query<{
      inventoryDeltaKey: string;
      status: InventoryPublicationItem["status"];
    }>(
      `SELECT
        inventory_delta_key AS "inventoryDeltaKey",
        status
      FROM inventory_publication_items
      WHERE inventory_delta_key = ANY($1::text[])`,
      [inventoryDeltaKeys],
      executor,
    );

    return new Map(rows.map((row) => [row.inventoryDeltaKey, row.status]));
  },

  async createOrFindPlanned(
    params: CreateInventoryPublication,
  ): Promise<CreateOrFindInventoryPublicationResult> {
    validateCreateParams(params);

    return withTransaction(async (client) => {
      const inserted = await queryOne<InventoryPublicationRow>(
        `INSERT INTO inventory_publications (
          planning_key,
          batch_number,
          pricing_job_id,
          method,
          source_type,
          seller_key,
          status,
          config_json
        ) VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7::jsonb)
        ON CONFLICT (planning_key) DO NOTHING
        RETURNING
          id,
          planning_key AS "planningKey",
          batch_number AS "batchNumber",
          pricing_job_id AS "pricingJobId",
          method,
          source_type AS "sourceType",
          seller_key AS "sellerKey",
          status,
          staged_pricing_upload_id AS "stagedPricingUploadId",
          config_json AS "config",
          progress_json AS "progress",
          error_code AS "errorCode",
          error_message AS "errorMessage",
          attempt_count AS "attemptCount",
          claimed_by AS "claimedBy",
          claim_expires_at AS "claimExpiresAt",
          staged_at AS "stagedAt",
          publishing_at AS "publishingAt",
          published_at AS "publishedAt",
          completed_at AS "completedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"`,
        [
          params.planningKey,
          params.batchNumber ?? null,
          params.pricingJobId ?? null,
          params.method,
          params.sourceType,
          params.sellerKey ?? null,
          asJson(params.config ?? {}),
        ],
        client,
      );

      if (!inserted) {
        const existing = await findByPlanningKey(params.planningKey, client);
        if (!existing) {
          throw new Error(
            `Inventory publication ${params.planningKey} could not be reloaded.`,
          );
        }

        return { publication: existing, created: false };
      }

      const placeholders = createValuesPlaceholders(params.items.length, 18);
      const values = params.items.flatMap((item) => [
        inserted.id,
        item.candidateKey,
        item.inventoryDeltaKey?.trim() || null,
        item.batchNumber ?? params.batchNumber ?? null,
        item.sku,
        item.productId,
        item.productLine,
        item.setName,
        item.productName,
        item.condition,
        item.previousPrice ?? null,
        item.desiredPrice,
        item.quantityDelta,
        item.observedQuantity ?? null,
        item.desiredAbsoluteQuantity ?? null,
        item.pricedAt,
        item.eligibilityReasons ?? [],
        item.status ?? "planned",
      ]);

      await execute(
        `INSERT INTO inventory_publication_items (
          publication_id,
          candidate_key,
          inventory_delta_key,
          batch_number,
          sku,
          product_id,
          product_line,
          set_name,
          product_name,
          condition,
          previous_price,
          desired_price,
          quantity_delta,
          observed_quantity,
          desired_absolute_quantity,
          priced_at,
          eligibility_reasons,
          status
        ) VALUES ${placeholders}`,
        values,
        client,
      );

      return {
        publication: await attachItems(inserted, client),
        created: true,
      };
    });
  },

  async claimNextPlanned(
    workerId: string,
    leaseMs: number,
  ): Promise<InventoryPublication | null> {
    requireNonEmptyText(workerId, "workerId");
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new RangeError("leaseMs must be a positive integer.");
    }

    return withTransaction(async (client) => {
      const claimed = await queryOne<InventoryPublicationRow>(
        `WITH next_publication AS (
          SELECT id
          FROM inventory_publications
          WHERE status = 'planned'
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE inventory_publications publication
        SET status = CASE
              WHEN publication.method = 'direct_absolute' THEN 'publishing'
              ELSE 'staging'
            END,
            publishing_at = CASE
              WHEN publication.method = 'direct_absolute' THEN NOW()
              ELSE publishing_at
            END,
            claimed_by = $1,
            claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
            attempt_count = attempt_count + 1,
            updated_at = NOW()
        FROM next_publication
        WHERE publication.id = next_publication.id
        RETURNING
          publication.id,
          publication.planning_key AS "planningKey",
          publication.batch_number AS "batchNumber",
          publication.pricing_job_id AS "pricingJobId",
          publication.method,
          publication.source_type AS "sourceType",
          publication.seller_key AS "sellerKey",
          publication.status,
          publication.staged_pricing_upload_id AS "stagedPricingUploadId",
          publication.config_json AS "config",
          publication.progress_json AS "progress",
          publication.error_code AS "errorCode",
          publication.error_message AS "errorMessage",
          publication.attempt_count AS "attemptCount",
          publication.claimed_by AS "claimedBy",
          publication.claim_expires_at AS "claimExpiresAt",
          publication.staged_at AS "stagedAt",
          publication.publishing_at AS "publishingAt",
          publication.published_at AS "publishedAt",
          publication.completed_at AS "completedAt",
          publication.created_at AS "createdAt",
          publication.updated_at AS "updatedAt"`,
        [workerId, leaseMs],
        client,
      );

      return claimed ? attachItems(claimed, client) : null;
    });
  },

  async heartbeat(
    publicationId: number,
    workerId: string,
    leaseMs: number,
    progress?: Record<string, unknown> | null,
  ): Promise<void> {
    await execute(
      `UPDATE inventory_publications
      SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          progress_json = COALESCE($4::jsonb, progress_json),
          updated_at = NOW()
      WHERE id = $1
        AND claimed_by = $2
        AND status IN ('staging', 'publishing')`,
      [publicationId, workerId, leaseMs, progress ? asJson(progress) : null],
    );
  },

  async recordStagedUploadId(
    publicationId: number,
    workerId: string,
    stagedPricingUploadId: number,
  ): Promise<void> {
    if (
      !Number.isInteger(stagedPricingUploadId) ||
      stagedPricingUploadId <= 0
    ) {
      throw new RangeError("stagedPricingUploadId must be a positive integer.");
    }

    const updated = await execute(
      `UPDATE inventory_publications
      SET staged_pricing_upload_id = $3,
          updated_at = NOW()
      WHERE id = $1
        AND claimed_by = $2
        AND status = 'staging'
        AND (staged_pricing_upload_id IS NULL OR staged_pricing_upload_id = $3)`,
      [publicationId, workerId, stagedPricingUploadId],
    );

    if (updated !== 1) {
      throw new Error(
        `Inventory publication ${publicationId} could not record staged upload ${stagedPricingUploadId}.`,
      );
    }
  },

  async transitionStatus(
    publicationId: number,
    expectedStatus: InventoryPublicationStatus,
    nextStatus: InventoryPublicationStatus,
    options: {
      workerId?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<InventoryPublication> {
    requireInventoryPublicationTransition(expectedStatus, nextStatus);

    const updated = await queryOne<InventoryPublicationRow>(
      `UPDATE inventory_publications
      SET status = $3,
          error_code = $5,
          error_message = $6,
          staged_at = CASE WHEN $3 = 'staged' THEN NOW() ELSE staged_at END,
          publishing_at = CASE
            WHEN $3 = 'publishing' THEN NOW()
            ELSE publishing_at
          END,
          published_at = CASE
            WHEN $3 = 'published' THEN NOW()
            ELSE published_at
          END,
          completed_at = CASE
            WHEN $3 IN ('published', 'failed', 'rolled_back') THEN NOW()
            ELSE completed_at
          END,
          claimed_by = CASE
            WHEN $3 IN ('staging', 'staged', 'publishing') THEN claimed_by
            ELSE NULL
          END,
          claim_expires_at = CASE
            WHEN $3 IN ('staging', 'staged', 'publishing') THEN claim_expires_at
            ELSE NULL
          END,
          updated_at = NOW()
      WHERE id = $1
        AND status = $2
        AND ($4::text IS NULL OR claimed_by = $4)
        AND ($3 <> 'staged' OR staged_pricing_upload_id IS NOT NULL)
      RETURNING
        id,
        planning_key AS "planningKey",
        batch_number AS "batchNumber",
        pricing_job_id AS "pricingJobId",
        method,
        source_type AS "sourceType",
        seller_key AS "sellerKey",
        status,
        staged_pricing_upload_id AS "stagedPricingUploadId",
        config_json AS "config",
        progress_json AS "progress",
        error_code AS "errorCode",
        error_message AS "errorMessage",
        attempt_count AS "attemptCount",
        claimed_by AS "claimedBy",
        claim_expires_at AS "claimExpiresAt",
        staged_at AS "stagedAt",
        publishing_at AS "publishingAt",
        published_at AS "publishedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"`,
      [
        publicationId,
        expectedStatus,
        nextStatus,
        options.workerId ?? null,
        options.errorCode ?? null,
        options.errorMessage ?? null,
      ],
    );

    if (!updated) {
      throw new Error(
        `Inventory publication ${publicationId} did not transition from ${expectedStatus} to ${nextStatus}.`,
      );
    }

    return attachItems(updated);
  },

  async saveItemOutcomes(
    publicationId: number,
    outcomes: InventoryPublicationItemOutcome[],
    executor?: Queryable,
  ): Promise<void> {
    if (outcomes.length === 0) {
      return;
    }

    if (!executor) {
      await withTransaction((client) =>
        inventoryPublicationsRepository.saveItemOutcomes(
          publicationId,
          outcomes,
          client,
        ),
      );
      return;
    }

    for (const outcome of outcomes) {
      const updated = await execute(
        `UPDATE inventory_publication_items
        SET status = $3,
            error_code = $4,
            error_message = $5,
            published_at = CASE
              WHEN $3 = 'published' THEN NOW()
              ELSE published_at
            END,
            updated_at = NOW()
        WHERE id = $1
          AND publication_id = $2
          AND status = 'planned'`,
        [
          outcome.itemId,
          publicationId,
          outcome.status,
          outcome.errorCode ?? null,
          outcome.errorMessage ?? null,
        ],
        executor,
      );

      if (updated !== 1) {
        throw new Error(
          `Publication item ${outcome.itemId} could not record ${outcome.status}.`,
        );
      }
    }
  },

  async markPlannedItems(
    publicationId: number,
    status: Extract<
      InventoryPublicationItemOutcome["status"],
      "ambiguous" | "failed"
    >,
    errorCode: string,
    errorMessage: string,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `UPDATE inventory_publication_items
      SET status = $2,
          error_code = $3,
          error_message = $4,
          updated_at = NOW()
      WHERE publication_id = $1
        AND status = 'planned'`,
      [publicationId, status, errorCode, errorMessage],
      executor,
    );
  },

  async getQueueHealth(): Promise<{
    counts: Partial<Record<InventoryPublicationStatus, number>>;
    oldestPlannedAt: Date | null;
    lastPublishedAt: Date | null;
  }> {
    const row = await queryOne<{
      counts: Partial<Record<InventoryPublicationStatus, number>>;
      oldestPlannedAt: Date | null;
      lastPublishedAt: Date | null;
    }>(
      `WITH status_counts AS (
        SELECT status, COUNT(*)::INTEGER AS count
        FROM inventory_publications
        GROUP BY status
      )
      SELECT
        COALESCE(jsonb_object_agg(status, count), '{}'::jsonb) AS counts,
        (SELECT MIN(created_at) FROM inventory_publications WHERE status = 'planned') AS "oldestPlannedAt",
        (SELECT MAX(published_at) FROM inventory_publications) AS "lastPublishedAt"
      FROM status_counts`,
    );

    return {
      counts: row?.counts ?? {},
      oldestPlannedAt: row?.oldestPlannedAt ?? null,
      lastPublishedAt: row?.lastPublishedAt ?? null,
    };
  },
  async recoverExpiredClaims(): Promise<number> {
    const recovered = await query<{ id: number }>(
      `UPDATE inventory_publications
      SET status = CASE
            WHEN status = 'publishing' THEN 'ambiguous'
            WHEN staged_pricing_upload_id IS NOT NULL THEN 'ambiguous'
            ELSE 'planned'
          END,
          error_code = CASE
            WHEN status = 'publishing'
              OR staged_pricing_upload_id IS NOT NULL
            THEN 'worker_lease_expired'
            ELSE error_code
          END,
          error_message = CASE
            WHEN status = 'publishing'
              OR staged_pricing_upload_id IS NOT NULL
            THEN 'Worker lease expired after Seller Portal state may have changed.'
            ELSE error_message
          END,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE status IN ('staging', 'staged', 'publishing')
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at < NOW()
      RETURNING id`,
    );

    return recovered.length;
  },
};
