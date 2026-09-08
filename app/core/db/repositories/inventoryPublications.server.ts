import type {
  CreateInventoryPublication,
  InventoryPublication,
  InventoryPublicationItem,
  InventoryPublicationItemOutcome,
  InventoryPublicationReceiptLink,
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
import { inventoryFifoRepository } from "./inventoryFifo.server";

type InventoryPublicationRow = Omit<InventoryPublication, "items">;
type InventoryPublicationItemRow = InventoryPublicationItem;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function safeDatabaseId(value: number | string | null, name: string): number | null {
  if (value === null) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${name} is outside the supported integer range.`);
  }
  return id;
}

function normalizePublicationRow(
  row: InventoryPublicationRow,
): InventoryPublicationRow {
  return {
    ...row,
    id: safeDatabaseId(row.id as number | string, "Publication ID")!,
    pricingJobId: safeDatabaseId(
      row.pricingJobId as number | string | null,
      "Pricing job ID",
    ),
  };
}

function normalizePublicationItem(
  row: InventoryPublicationItemRow,
): InventoryPublicationItem {
  return {
    ...row,
    id: safeDatabaseId(row.id as number | string, "Publication item ID")!,
    publicationId: safeDatabaseId(
      row.publicationId as number | string,
      "Publication ID",
    )!,
  };
}

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
  forecast_evidence AS "forecastEvidence",
  forecast_evidence_provenance AS "forecastEvidenceProvenance",
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

  if (
    params.sourceType === "pending_inventory" &&
    params.items.some((item) => item.quantityDelta > 0) &&
    params.method !== "staged_delta"
  ) {
    throw new RangeError(
      "Received inventory can only be published with staged quantity deltas.",
    );
  }

  if (
    params.sourceType === "pending_inventory" &&
    params.items.some((item) => item.quantityDelta > 0) &&
    !params.sellerKey?.trim()
  ) {
    throw new RangeError(
      "sellerKey is required for received inventory publication.",
    );
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
    if (
      item.forecastEvidence &&
      item.forecastEvidence.source !== "publication_candidate"
    ) {
      throw new RangeError(
        `${prefix}.forecastEvidence must come from the publication candidate.`,
      );
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

async function linkPendingInventoryReceipts(
  publicationId: number,
  sellerKey: string,
  executor: Queryable,
): Promise<void> {
  const items = await query<{
    itemId: number;
    batchNumber: number | null;
    sku: number;
    quantityDelta: number;
  }>(
    `SELECT
      id AS "itemId",
      batch_number AS "batchNumber",
      sku,
      quantity_delta AS "quantityDelta"
    FROM inventory_publication_items
    WHERE publication_id = $1 AND quantity_delta > 0`,
    [publicationId],
    executor,
  );

  for (const item of items) {
    if (!item.batchNumber) {
      throw new Error(
        `Publication item ${item.itemId} cannot link receipts without a batch.`,
      );
    }

    const receiptSummary = await queryOne<{
      linkedQuantity: number;
      mismatchedSellerCount: number;
    }>(
      `SELECT
        COALESCE(SUM(link.linked_quantity), 0)::int AS "linkedQuantity",
        COUNT(*) FILTER (
          WHERE receipt.seller_key IS NOT NULL
            AND receipt.seller_key <> $3
        )::int AS "mismatchedSellerCount"
      FROM inventory_receipt_batch_links link
      JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
      WHERE link.batch_number = $1 AND receipt.sku = $2`,
      [item.batchNumber, item.sku, sellerKey],
      executor,
    );
    if ((receiptSummary?.mismatchedSellerCount ?? 0) > 0) {
      throw new Error(
        `SKU ${item.sku} has receipt lots assigned to a different seller.`,
      );
    }
    if ((receiptSummary?.linkedQuantity ?? 0) !== item.quantityDelta) {
      throw new Error(
        `SKU ${item.sku} publication quantity ${item.quantityDelta} does not match linked receipt quantity ${receiptSummary?.linkedQuantity ?? 0}.`,
      );
    }

    await execute(
      `INSERT INTO inventory_publication_receipt_links (
        publication_item_id,
        receipt_id,
        planned_quantity,
        target_seller_key
      )
      SELECT $1, link.receipt_id, link.linked_quantity, $4
      FROM inventory_receipt_batch_links link
      JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
      WHERE link.batch_number = $2 AND receipt.sku = $3`,
      [item.itemId, item.batchNumber, item.sku, sellerKey],
      executor,
    );
  }
}

async function findItems(
  publicationId: number,
  executor?: Queryable,
): Promise<InventoryPublicationItem[]> {
  const rows = await query<InventoryPublicationItemRow>(
    `${publicationItemSelect}
    WHERE publication_id = $1
    ORDER BY id`,
    [publicationId],
    executor,
  );
  return rows.map(normalizePublicationItem);
}

async function attachItems(
  publication: InventoryPublicationRow,
  executor?: Queryable,
): Promise<InventoryPublication> {
  return {
    ...normalizePublicationRow(publication),
    items: await findItems(
      safeDatabaseId(publication.id as number | string, "Publication ID")!,
      executor,
    ),
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

function plannedPublicationIdentity(
  publication: InventoryPublication,
): string {
  return JSON.stringify({
    batchNumber: publication.batchNumber,
    pricingJobId: publication.pricingJobId,
    method: publication.method,
    sourceType: publication.sourceType,
    sellerKey: publication.sellerKey,
    items: publication.items.map((item) => ({
      candidateKey: item.candidateKey,
      inventoryDeltaKey: item.inventoryDeltaKey,
      batchNumber: item.batchNumber,
      sku: item.sku,
      productId: item.productId,
      productLine: item.productLine,
      setName: item.setName,
      productName: item.productName,
      condition: item.condition,
      previousPrice: item.previousPrice,
      desiredPrice: item.desiredPrice,
      quantityDelta: item.quantityDelta,
      observedQuantity: item.observedQuantity,
      desiredAbsoluteQuantity: item.desiredAbsoluteQuantity,
      pricedAt: item.pricedAt.toISOString(),
      eligibilityReasons: item.eligibilityReasons,
      forecastEvidence: canonicalJson(
        item.forecastEvidence?.source ===
          "historical_pricing_result_exact_match"
          ? null
          : item.forecastEvidence,
      ),
    })),
  });
}

function requestedPublicationIdentity(
  params: CreateInventoryPublication,
): string {
  return JSON.stringify({
    batchNumber: params.batchNumber ?? null,
    pricingJobId: params.pricingJobId ?? null,
    method: params.method,
    sourceType: params.sourceType,
    sellerKey: params.sellerKey?.trim() || null,
    items: params.items.map((item) => ({
      candidateKey: item.candidateKey,
      inventoryDeltaKey: item.inventoryDeltaKey?.trim() || null,
      batchNumber: item.batchNumber ?? params.batchNumber ?? null,
      sku: item.sku,
      productId: item.productId,
      productLine: item.productLine,
      setName: item.setName,
      productName: item.productName,
      condition: item.condition,
      previousPrice: item.previousPrice ?? null,
      desiredPrice: item.desiredPrice,
      quantityDelta: item.quantityDelta,
      observedQuantity: item.observedQuantity ?? null,
      desiredAbsoluteQuantity: item.desiredAbsoluteQuantity ?? null,
      pricedAt: item.pricedAt.toISOString(),
      eligibilityReasons: item.eligibilityReasons ?? [],
      forecastEvidence: canonicalJson(item.forecastEvidence ?? null),
    })),
  });
}

export const inventoryPublicationsRepository = {
  async backfillSupportedForecastEvidence(
    sellerKey: string,
    limit = 500,
  ): Promise<number> {
    const seller = sellerKey.trim();
    if (!seller) throw new Error("Seller key is required for forecast evidence backfill.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Forecast evidence backfill limit must be between 1 and 1000.");
    }
    const rows = await query<{ id: number }>(
      `WITH supported AS (
        SELECT item.id,result.pricing_details_json
        FROM inventory_publication_items item
        JOIN inventory_publications publication ON publication.id=item.publication_id
        JOIN inventory_batch_results result
          ON result.batch_number=item.batch_number AND result.sku=item.sku
          AND result.priced_at=item.priced_at
        WHERE publication.seller_key=$1
          AND item.forecast_evidence IS NULL AND item.status='published'
          AND item.quantity_delta>0
          AND result.result_status='successful'
          AND result.pricing_details_json IS NOT NULL
          AND item.candidate_key='pricing-result:'||result.batch_number::text||':'||
            result.sku::text||':'||to_char(result.priced_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND jsonb_typeof(result.pricing_details_json->'schemaVersion')='number'
          AND result.pricing_details_json->>'pricedAt'=to_char(
            result.priced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND result.pricing_details_json->>'marketplacePrice' ~ '^[0-9]+(\.[0-9]+)?$'
          AND (result.pricing_details_json->>'marketplacePrice')::numeric(12,2)=item.desired_price
        ORDER BY item.id LIMIT $2
      )
      UPDATE inventory_publication_items item SET
        forecast_evidence=jsonb_strip_nulls(jsonb_build_object(
          'source','historical_pricing_result_exact_match',
          'schemaVersion',supported.pricing_details_json->'schemaVersion',
          'pricingModelVersion',supported.pricing_details_json->'pricingModelVersion',
          'pricedAt',supported.pricing_details_json->'pricedAt',
          'policy',supported.pricing_details_json->'policy',
          'decision',supported.pricing_details_json->'decision',
          'buyerChoiceForecast',supported.pricing_details_json->'buyerChoiceForecast',
          'conditionRateForecast',supported.pricing_details_json->'conditionRateForecast',
          'estimatedTimeToSellDays',supported.pricing_details_json->'estimatedTimeToSellDays')),
        forecast_evidence_provenance='recorded',updated_at=NOW()
      FROM supported WHERE item.id=supported.id RETURNING item.id`,
      [seller, limit],
    );
    return rows.length;
  },
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
          params.sellerKey?.trim() || null,
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

        if (
          plannedPublicationIdentity(existing) !==
          requestedPublicationIdentity(params)
        ) {
          throw new Error(
            `Inventory publication ${params.planningKey} already exists with different planning inputs.`,
          );
        }

        return { publication: existing, created: false };
      }

      const placeholders = createValuesPlaceholders(params.items.length, 20);
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
        item.forecastEvidence ? asJson(item.forecastEvidence) : null,
        item.forecastEvidence ? "recorded" : "unknown",
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
          forecast_evidence,
          forecast_evidence_provenance,
          status
        ) VALUES ${placeholders}`,
        values,
        client,
      );

      if (
        params.sourceType === "pending_inventory" &&
        params.items.some((item) => item.quantityDelta > 0)
      ) {
        await linkPendingInventoryReceipts(
          inserted.id,
          params.sellerKey!.trim(),
          client,
        );
      }

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

    const publication = await queryOne<{
      sourceType: InventoryPublication["sourceType"];
      method: InventoryPublication["method"];
      sellerKey: string | null;
    }>(
      `SELECT source_type AS "sourceType", method, seller_key AS "sellerKey"
      FROM inventory_publications
      WHERE id = $1
      FOR UPDATE`,
      [publicationId],
      executor,
    );
    if (!publication) {
      throw new Error(`Inventory publication ${publicationId} not found.`);
    }

    for (const outcome of outcomes) {
      const item = await queryOne<{
        status: InventoryPublicationItem["status"];
        sku: number;
        quantityDelta: number;
        publishedAt: Date | null;
      }>(
        `SELECT
          status, sku,
          quantity_delta AS "quantityDelta",
          published_at AS "publishedAt"
        FROM inventory_publication_items
        WHERE id = $1 AND publication_id = $2
        FOR UPDATE`,
        [outcome.itemId, publicationId],
        executor,
      );
      if (!item) {
        throw new Error(`Publication item ${outcome.itemId} not found.`);
      }
      const correction = item.status === "ambiguous" && outcome.status === "published";
      const repeated = item.status === outcome.status;
      if (item.status !== "planned" && !repeated && !correction) {
        throw new Error(
          `Publication item ${outcome.itemId} cannot change from ${item.status} to ${outcome.status}.`,
        );
      }

      const activatesReceipts =
        publication.sourceType === "pending_inventory" &&
        publication.method === "staged_delta" &&
        item.quantityDelta > 0 &&
        outcome.status === "published";
      if (
        activatesReceipts &&
        (!publication.sellerKey ||
          !outcome.confirmedAt ||
          !outcome.confirmationEvidence)
      ) {
        throw new Error(
          `Publication item ${outcome.itemId} requires seller, confirmation time, and evidence before receipt activation.`,
        );
      }

      await execute(
        `UPDATE inventory_publication_items
        SET status = $3,
            error_code = $4,
            error_message = $5,
            published_at = CASE
              WHEN $3 = 'published' THEN COALESCE(published_at, $6)
              ELSE published_at
            END,
            updated_at = NOW()
        WHERE id = $1
          AND publication_id = $2
          AND status = ANY($7::text[])`,
        [
          outcome.itemId,
          publicationId,
          outcome.status,
          outcome.errorCode ?? null,
          outcome.errorMessage ?? null,
          outcome.confirmedAt ?? new Date(),
          correction
            ? ["planned", "ambiguous", "published"]
            : ["planned", outcome.status],
        ],
        executor,
      );

      if (activatesReceipts) {
        const linked = await queryOne<{
          plannedQuantity: number;
          mismatchedSellerCount: number;
          linkCount: number;
          activatedCount: number;
          conflictingEvidenceCount: number;
        }>(
          `SELECT
            COALESCE(SUM(link.planned_quantity), 0)::int AS "plannedQuantity",
            COUNT(*)::int AS "linkCount",
            COUNT(*) FILTER (WHERE link.live_at IS NOT NULL)::int AS "activatedCount",
            COUNT(*) FILTER (
              WHERE receipt.seller_key IS NOT NULL
                AND receipt.seller_key <> $2
            )::int AS "mismatchedSellerCount",
            COUNT(*) FILTER (
              WHERE link.live_at IS NOT NULL
                AND (
                  link.live_at <> $3
                  OR link.confirmation_evidence IS DISTINCT FROM $4::jsonb
                )
            )::int AS "conflictingEvidenceCount"
          FROM inventory_publication_receipt_links link
          JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
          WHERE link.publication_item_id = $1
            AND link.target_seller_key = $2`,
          [
            outcome.itemId,
            publication.sellerKey,
            outcome.confirmedAt,
            asJson(outcome.confirmationEvidence),
          ],
          executor,
        );
        if ((linked?.mismatchedSellerCount ?? 0) > 0) {
          throw new Error(
            `Publication item ${outcome.itemId} has receipts assigned to another seller.`,
          );
        }
        if ((linked?.plannedQuantity ?? 0) !== item.quantityDelta) {
          throw new Error(
            `Publication item ${outcome.itemId} cannot activate ${item.quantityDelta} units from ${linked?.plannedQuantity ?? 0} linked units.`,
          );
        }
        if (
          repeated &&
          ((linked?.activatedCount ?? 0) !== (linked?.linkCount ?? 0) ||
            (linked?.conflictingEvidenceCount ?? 0) > 0 ||
            item.publishedAt?.getTime() !== outcome.confirmedAt?.getTime())
        ) {
          throw new Error(
            `Publication item ${outcome.itemId} already has different confirmation evidence.`,
          );
        }

        await execute(
          `UPDATE inventory_receipts receipt
          SET seller_key = $2
          FROM inventory_publication_receipt_links link
          WHERE link.publication_item_id = $1
            AND link.receipt_id = receipt.receipt_id
            AND receipt.seller_key IS NULL`,
          [outcome.itemId, publication.sellerKey],
          executor,
        );
        await execute(
          `UPDATE inventory_publication_receipt_links
          SET live_at = COALESCE(live_at, $2),
              activated_at = COALESCE(activated_at, NOW()),
              confirmation_evidence = COALESCE(confirmation_evidence, $3::jsonb)
          WHERE publication_item_id = $1`,
          [
            outcome.itemId,
            outcome.confirmedAt,
            asJson(outcome.confirmationEvidence),
          ],
          executor,
        );
        if (!repeated) {
          await inventoryFifoRepository.enqueueSellerSku(
            publication.sellerKey!,
            item.sku,
            outcome.confirmedAt!,
            executor,
          );
        }
      }
    }
  },

  async recoverPublicationsWithSavedOutcomes(): Promise<number> {
    const recovered = await query<{ id: number }>(
      `UPDATE inventory_publications publication
      SET status = 'published',
          published_at = COALESCE(
            publication.published_at,
            (SELECT MAX(item.published_at)
             FROM inventory_publication_items item
             WHERE item.publication_id = publication.id)
          ),
          completed_at = COALESCE(publication.completed_at, NOW()),
          error_code = NULL,
          error_message = NULL,
          claimed_by = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE (
          publication.status = 'ambiguous'
          OR (
            publication.status = 'publishing'
            AND (
              publication.claimed_by IS NULL
              OR publication.claim_expires_at IS NULL
              OR publication.claim_expires_at < NOW()
            )
          )
        )
        AND EXISTS (
          SELECT 1 FROM inventory_publication_items item
          WHERE item.publication_id = publication.id
            AND item.status = 'published'
        )
        AND NOT EXISTS (
          SELECT 1 FROM inventory_publication_items item
          WHERE item.publication_id = publication.id
            AND item.status IN ('planned', 'ambiguous')
        )
      RETURNING publication.id`,
    );
    return recovered.length;
  },

  async findReceiptLinks(
    publicationItemId: number,
    executor?: Queryable,
  ): Promise<InventoryPublicationReceiptLink[]> {
    return query<InventoryPublicationReceiptLink>(
      `SELECT
        link.publication_item_id AS "publicationItemId",
        link.receipt_id AS "receiptId",
        link.planned_quantity AS "plannedQuantity",
        link.target_seller_key AS "targetSellerKey",
        link.live_at AS "liveAt",
        link.activated_at AS "activatedAt",
        link.confirmation_evidence AS "confirmationEvidence",
        receipt.intake_at AS "intakeAt"
      FROM inventory_publication_receipt_links link
      JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
      WHERE link.publication_item_id = $1
      ORDER BY receipt.intake_at NULLS FIRST, receipt.receipt_id`,
      [publicationItemId],
      executor,
    );
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
    return withTransaction(async (client) => {
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
        [],
        client,
      );
      if (recovered.length > 0) {
        await execute(
          `UPDATE inventory_publication_items item
          SET status = 'ambiguous',
              error_code = 'worker_lease_expired',
              error_message = 'Worker lease expired after Seller Portal state may have changed.',
              updated_at = NOW()
          FROM inventory_publications publication
          WHERE item.publication_id = publication.id
            AND publication.id = ANY($1::bigint[])
            AND publication.status = 'ambiguous'
            AND item.status = 'planned'`,
          [recovered.map((row) => row.id)],
          client,
        );
      }
      return recovered.length;
    });
  },
};
