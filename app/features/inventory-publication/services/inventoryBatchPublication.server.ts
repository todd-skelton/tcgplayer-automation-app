import {
  inventoryBatchesRepository,
  inventoryPublicationsRepository,
} from "~/core/db";
import type {
  InventoryBatch,
  InventoryBatchItem,
  InventoryBatchResult,
} from "~/features/pending-inventory/types/inventoryBatch";
import {
  createInventoryDeltaKey,
  createPricingCandidateKey,
  evaluateInventoryPublicationCandidate,
} from "./inventoryPublicationPolicy";
import {
  DEFAULT_INVENTORY_PUBLICATION_POLICY,
  type InventoryPublication,
  type InventoryPublicationEligibilityReason,
  type InventoryPublicationItemStatus,
  type InventoryPublicationPolicy,
  type InventoryPublicationSourceType,
} from "../types/inventoryPublication";

export interface InventoryBatchPublicationPreviewItem {
  sku: number;
  productId: number;
  productLine: string;
  setName: string;
  productName: string;
  condition: string;
  previousPrice: number | null;
  desiredPrice: number | null;
  originalQuantityDelta: number;
  quantityDelta: number;
  inventoryDeltaAlreadyPlanned: boolean;
  pricedAt: Date;
  eligible: boolean;
  reasons: InventoryPublicationEligibilityReason[];
  candidateKey: string;
  inventoryDeltaKey: string | null;
}

export interface InventoryBatchPublicationPreview {
  batchNumber: number;
  pricingJobId: number;
  planningKey: string;
  sourceType: InventoryPublicationSourceType;
  sourceLabel: string;
  successfulResultCount: number;
  existingManualReviewCount: number;
  eligibleCount: number;
  excludedCount: number;
  items: InventoryBatchPublicationPreviewItem[];
}

interface InventoryBatchPublicationDependencies {
  findBatch(batchNumber: number): Promise<InventoryBatch | null>;
  findItems(batchNumber: number): Promise<InventoryBatchItem[]>;
  findSuccessfulResults(batchNumber: number): Promise<InventoryBatchResult[]>;
  findInventoryDeltaStatuses(
    keys: string[],
  ): Promise<Map<string, InventoryPublicationItemStatus>>;
  createPublication(
    params: Parameters<
      typeof inventoryPublicationsRepository.createOrFindPlanned
    >[0],
  ): Promise<
    Awaited<
      ReturnType<typeof inventoryPublicationsRepository.createOrFindPlanned>
    >
  >;
}

const defaultDependencies: InventoryBatchPublicationDependencies = {
  findBatch: (batchNumber) =>
    inventoryBatchesRepository.findByBatchNumber(batchNumber),
  findItems: (batchNumber) =>
    inventoryBatchesRepository.findItems(batchNumber, "all"),
  findSuccessfulResults: (batchNumber) =>
    inventoryBatchesRepository.findResults(batchNumber, "successful"),
  findInventoryDeltaStatuses: (keys) =>
    inventoryPublicationsRepository.findInventoryDeltaStatuses(keys),
  createPublication: (params) =>
    inventoryPublicationsRepository.createOrFindPlanned(params),
};

function parsePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function addReason(
  reasons: InventoryPublicationEligibilityReason[],
  reason: InventoryPublicationEligibilityReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function requirePublishableBatch(batch: InventoryBatch): number {
  if (!batch.latestJob || batch.latestJob.status !== "completed") {
    throw new Error(
      `Batch ${batch.batchNumber} does not have a completed pricing job.`,
    );
  }
  return batch.latestJob.id;
}

export async function previewInventoryBatchPublication(
  batchNumber: number,
  options: {
    policy?: InventoryPublicationPolicy;
    now?: Date;
    mode?: "manual" | "automatic";
    dependencies?: InventoryBatchPublicationDependencies;
  } = {},
): Promise<InventoryBatchPublicationPreview> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const policy = options.policy ?? DEFAULT_INVENTORY_PUBLICATION_POLICY;
  const now = options.now ?? new Date();

  const batch = await dependencies.findBatch(batchNumber);
  if (!batch) {
    throw new Error(`Batch ${batchNumber} not found.`);
  }
  const pricingJobId = requirePublishableBatch(batch);

  const [batchItems, results] = await Promise.all([
    dependencies.findItems(batchNumber),
    dependencies.findSuccessfulResults(batchNumber),
  ]);
  const batchItemsBySku = new Map(batchItems.map((item) => [item.sku, item]));
  const possibleDeltaKeys = batchItems
    .filter((item) => item.addToQuantity !== 0)
    .map((item) =>
      createInventoryDeltaKey({
        batchNumber,
        sku: item.sku,
      }),
    );
  const existingDeltaStatuses =
    await dependencies.findInventoryDeltaStatuses(possibleDeltaKeys);

  const items = results.map((result): InventoryBatchPublicationPreviewItem => {
    const batchItem = batchItemsBySku.get(result.sku);
    const originalQuantityDelta = batchItem?.addToQuantity ?? 0;
    const possibleDeltaKey =
      originalQuantityDelta !== 0
        ? createInventoryDeltaKey({
            batchNumber,
            sku: result.sku,
          })
        : null;
    const existingDeltaStatus = possibleDeltaKey
      ? existingDeltaStatuses.get(possibleDeltaKey)
      : undefined;
    const inventoryDeltaAlreadyPlanned = existingDeltaStatus !== undefined;
    const inventoryDeltaPublished = existingDeltaStatus === "published";
    const quantityDelta = inventoryDeltaAlreadyPlanned
      ? inventoryDeltaPublished
        ? 0
        : originalQuantityDelta
      : originalQuantityDelta;
    const inventoryDeltaKey =
      quantityDelta !== 0 && !inventoryDeltaAlreadyPlanned
        ? possibleDeltaKey
        : null;
    const price =
      result.pricingDetails?.marketplacePrice ??
      parsePrice(result.row["TCG Marketplace Price"]);
    const previousPrice =
      result.pricingDetails?.previousPrice ??
      parsePrice(result.row["Previous Price"]) ??
      batchItem?.currentPrice ??
      null;
    const productLine = result.row["Product Line"]?.trim() ?? "";
    const setName = result.row["Set Name"]?.trim() ?? "";
    const productName = result.row.Product?.trim() ?? "";
    const condition = result.row["Sku Condition"]?.trim() ?? "";
    const decision = evaluateInventoryPublicationCandidate(
      {
        sourceType: batch.sourceType,
        batchNumber,
        sku: result.sku,
        price,
        previousPrice,
        quantityDelta,
        pricedAt: result.pricedAt,
        errors: result.errorMessages,
        isNewInventory: originalQuantityDelta !== 0,
        warnings: result.warningMessages,
      },
      policy,
      now,
      options.mode ?? "manual",
    );
    const reasons = [...decision.reasons];

    if (!batchItem || batchItem.productId <= 0) {
      addReason(reasons, "missing_product_metadata");
    }
    if (!productLine || !setName || !productName || !condition) {
      addReason(reasons, "missing_product_metadata");
    }
    if (batch.sourceType === "csv" && quantityDelta !== 0) {
      addReason(reasons, "csv_quantity_delta_requires_review");
    }
    if (existingDeltaStatus === "ambiguous") {
      addReason(reasons, "inventory_delta_ambiguous");
    } else if (
      existingDeltaStatus !== undefined &&
      existingDeltaStatus !== "published"
    ) {
      addReason(reasons, "inventory_delta_already_planned");
    }

    return {
      sku: result.sku,
      productId: batchItem?.productId ?? 0,
      productLine,
      setName,
      productName,
      condition,
      previousPrice,
      desiredPrice: decision.roundedPrice ?? null,
      originalQuantityDelta,
      quantityDelta,
      inventoryDeltaAlreadyPlanned,
      pricedAt: result.pricedAt,
      eligible: reasons.length === 0,
      reasons,
      candidateKey: createPricingCandidateKey({
        batchNumber,
        sku: result.sku,
        pricedAt: result.pricedAt,
      }),
      inventoryDeltaKey,
    };
  });

  const eligibleCount = items.filter((item) => item.eligible).length;

  return {
    batchNumber,
    pricingJobId,
    planningKey: `inventory-batch-pricing-job:${pricingJobId}`,
    sourceType: batch.sourceType,
    sourceLabel: batch.sourceLabel,
    successfulResultCount: results.length,
    existingManualReviewCount: batch.manualReviewCount,
    eligibleCount,
    excludedCount: items.length - eligibleCount + batch.manualReviewCount,
    items,
  };
}

export async function planInventoryBatchPublication(
  batchNumber: number,
  options: {
    policy?: InventoryPublicationPolicy;
    now?: Date;
    dependencies?: InventoryBatchPublicationDependencies;
    mode?: "manual" | "automatic";
  } = {},
): Promise<{
  publication: InventoryPublication;
  preview: InventoryBatchPublicationPreview;
  created: boolean;
}> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const preview = await previewInventoryBatchPublication(batchNumber, {
    ...options,
    dependencies,
  });
  const eligibleItems = preview.items.filter(
    (
      item,
    ): item is InventoryBatchPublicationPreviewItem & {
      desiredPrice: number;
    } => item.eligible && item.desiredPrice !== null,
  );

  if (eligibleItems.length === 0) {
    throw new Error(
      `Batch ${batchNumber} has no pricing results eligible for publication.`,
    );
  }

  const result = await dependencies.createPublication({
    planningKey: preview.planningKey,
    batchNumber,
    pricingJobId: preview.pricingJobId,
    method: "staged_delta",
    sourceType: preview.sourceType,
    sellerKey:
      preview.sourceType === "seller" || preview.sourceType === "continuous"
        ? preview.sourceLabel
        : undefined,
    config: {
      policy: options.policy ?? DEFAULT_INVENTORY_PUBLICATION_POLICY,
      mode: options.mode ?? "manual",
    },
    items: eligibleItems.map((item) => ({
      candidateKey: item.candidateKey,
      inventoryDeltaKey: item.inventoryDeltaKey,
      batchNumber,
      sku: item.sku,
      productId: item.productId,
      productLine: item.productLine,
      setName: item.setName,
      productName: item.productName,
      condition: item.condition,
      previousPrice: item.previousPrice,
      desiredPrice: item.desiredPrice,
      quantityDelta: item.quantityDelta,
      pricedAt: item.pricedAt,
      eligibilityReasons: [],
      status: "planned",
    })),
  });

  return {
    publication: result.publication,
    preview,
    created: result.created,
  };
}
