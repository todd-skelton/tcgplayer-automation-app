import { createHash } from "node:crypto";
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
  type CreateInventoryPublication,
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
  findExistingPricingCandidateKeys(keys: string[]): Promise<Set<string>>;
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
  findExistingPricingCandidateKeys: (keys) =>
    inventoryPublicationsRepository.findExistingPricingCandidateKeys(keys),
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

function buildPublicationCondition(row: InventoryBatchResult["row"]): string {
  const condition = row["Sku Condition"]?.trim() ?? "";
  const variant = row["Sku Variant"]?.trim() ?? "";

  if (
    !condition ||
    !variant ||
    variant.toLowerCase() === "normal" ||
    condition.toLowerCase().includes(variant.toLowerCase())
  ) {
    return condition;
  }

  return `${condition} ${variant}`;
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

function normalizeSelectedSkus(
  selectedSkus: readonly number[] | undefined,
): number[] | null {
  if (selectedSkus === undefined) {
    return null;
  }

  if (
    selectedSkus.length === 0 ||
    selectedSkus.some((sku) => !Number.isInteger(sku) || sku <= 0)
  ) {
    throw new Error("Select at least one valid SKU for publication.");
  }

  return [...new Set(selectedSkus)].sort((left, right) => left - right);
}

function createSelectedPlanningKey(
  pricingJobId: number,
  selectedSkus: readonly number[] | null,
): string {
  const baseKey = `inventory-batch-pricing-job:${pricingJobId}`;
  if (!selectedSkus) {
    return baseKey;
  }

  const selectionHash = createHash("sha256")
    .update(selectedSkus.join(","))
    .digest("hex")
    .slice(0, 16);
  return `${baseKey}:selection:${selectionHash}`;
}

type PublishablePreviewItem = InventoryBatchPublicationPreviewItem & {
  desiredPrice: number;
};

function selectPublishableItems(
  preview: InventoryBatchPublicationPreview,
  selectedSkus: readonly number[] | null,
): PublishablePreviewItem[] {
  const allEligibleItems = preview.items.filter(
    (item): item is PublishablePreviewItem =>
      item.eligible && item.desiredPrice !== null,
  );
  const eligibleItems = selectedSkus
    ? allEligibleItems.filter((item) => selectedSkus.includes(item.sku))
    : allEligibleItems;

  if (selectedSkus) {
    const eligibleSkuSet = new Set(eligibleItems.map((item) => item.sku));
    const rejectedSkus = selectedSkus.filter((sku) => !eligibleSkuSet.has(sku));
    if (rejectedSkus.length > 0) {
      throw new Error(
        `Selected SKUs are missing or ineligible: ${rejectedSkus.join(", ")}.`,
      );
    }
  }

  if (eligibleItems.length === 0) {
    throw new Error(
      `Batch ${preview.batchNumber} has no pricing results eligible for publication.`,
    );
  }

  return eligibleItems;
}

function createPublicationParams(
  preview: InventoryBatchPublicationPreview,
  policy: InventoryPublicationPolicy,
  mode: "manual" | "automatic",
  items: readonly PublishablePreviewItem[],
  selectedSkus: readonly number[] | null = items.map((item) => item.sku),
  targetSellerKey?: string,
): CreateInventoryPublication {
  const sellerKey = targetSellerKey?.trim() || undefined;

  return {
    planningKey: createSelectedPlanningKey(preview.pricingJobId, selectedSkus),
    batchNumber: preview.batchNumber,
    pricingJobId: preview.pricingJobId,
    method: "staged_delta",
    sourceType: preview.sourceType,
    sellerKey:
      preview.sourceType === "seller" || preview.sourceType === "continuous"
        ? preview.sourceLabel
        : preview.sourceType === "pending_inventory"
          ? sellerKey
          : undefined,
    config: {
      policy,
      mode,
      selectedSkus,
    },
    items: items.map((item) => ({
      candidateKey: item.candidateKey,
      inventoryDeltaKey: item.inventoryDeltaKey,
      batchNumber: preview.batchNumber,
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
  };
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
  if (batch.sourceType === "strategy") {
    throw new Error(
      `Batch ${batchNumber} is an analysis-only strategy batch and cannot be published.`,
    );
  }
  const publicationSourceType: InventoryPublicationSourceType =
    batch.sourceType;
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
  const candidateKeys = results.map((result) =>
    createPricingCandidateKey({
      batchNumber,
      sku: result.sku,
      pricedAt: result.pricedAt,
    }),
  );
  const [existingDeltaStatuses, existingPricingCandidateKeys] =
    await Promise.all([
      dependencies.findInventoryDeltaStatuses(possibleDeltaKeys),
      dependencies.findExistingPricingCandidateKeys(candidateKeys),
    ]);

  const items = results.map((result): InventoryBatchPublicationPreviewItem => {
    const candidateKey = createPricingCandidateKey({
      batchNumber,
      sku: result.sku,
      pricedAt: result.pricedAt,
    });
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
    const catalogRow = batchItem?.originalRow ?? result.row;
    const productLine = catalogRow["Product Line"]?.trim() ?? "";
    const setName = catalogRow["Set Name"]?.trim() ?? "";
    const productName = catalogRow.Product?.trim() ?? "";
    const condition = buildPublicationCondition(catalogRow);
    const decision = evaluateInventoryPublicationCandidate(
      {
        sourceType: publicationSourceType,
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
    if (existingPricingCandidateKeys.has(candidateKey)) {
      addReason(reasons, "pricing_candidate_already_used");
    }
    if (publicationSourceType === "csv" && quantityDelta !== 0) {
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
      candidateKey,
      inventoryDeltaKey,
    };
  });

  const eligibleCount = items.filter((item) => item.eligible).length;

  return {
    batchNumber,
    pricingJobId,
    planningKey: `inventory-batch-pricing-job:${pricingJobId}`,
    sourceType: publicationSourceType,
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
    selectedSkus?: readonly number[];
    targetSellerKey?: string;
  } = {},
): Promise<{
  publication: InventoryPublication;
  preview: InventoryBatchPublicationPreview;
  created: boolean;
}> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const selectedSkus = normalizeSelectedSkus(options.selectedSkus);
  const preview = await previewInventoryBatchPublication(batchNumber, {
    ...options,
    dependencies,
  });
  const eligibleItems = selectPublishableItems(preview, selectedSkus);

  if (selectedSkus) {
    const maximum =
      options.policy?.stagedMicroBatchMaximum ??
      DEFAULT_INVENTORY_PUBLICATION_POLICY.stagedMicroBatchMaximum;
    if (eligibleItems.length > maximum) {
      throw new Error(
        `Select no more than ${maximum} SKUs for one staged publication.`,
      );
    }
  }
  const params = createPublicationParams(
    preview,
    options.policy ?? DEFAULT_INVENTORY_PUBLICATION_POLICY,
    options.mode ?? "manual",
    eligibleItems,
    selectedSkus,
    options.targetSellerKey,
  );
  const result = await dependencies.createPublication(params);

  return {
    publication: result.publication,
    preview: {
      ...preview,
      planningKey: params.planningKey,
    },
    created: result.created,
  };
}

export async function planInventoryBatchPublications(
  batchNumber: number,
  options: {
    policy?: InventoryPublicationPolicy;
    now?: Date;
    dependencies?: InventoryBatchPublicationDependencies;
    mode?: "manual" | "automatic";
    selectedSkus?: readonly number[];
    targetSellerKey?: string;
  } = {},
): Promise<{
  publications: InventoryPublication[];
  preview: InventoryBatchPublicationPreview;
  createdCount: number;
}> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const policy = options.policy ?? DEFAULT_INVENTORY_PUBLICATION_POLICY;
  const mode = options.mode ?? "manual";
  const selectedSkus = normalizeSelectedSkus(options.selectedSkus);
  const preview = await previewInventoryBatchPublication(batchNumber, {
    ...options,
    dependencies,
  });
  const eligibleItems = selectPublishableItems(preview, selectedSkus);
  const maximum = policy.stagedMicroBatchMaximum;
  if (!Number.isInteger(maximum) || maximum <= 0) {
    throw new Error("The staged publication batch maximum must be positive.");
  }
  const chunks: PublishablePreviewItem[][] = [];

  for (let index = 0; index < eligibleItems.length; index += maximum) {
    chunks.push(eligibleItems.slice(index, index + maximum));
  }

  const results = [];
  for (const chunk of chunks) {
    results.push(
      await dependencies.createPublication(
        createPublicationParams(
          preview,
          policy,
          mode,
          chunk,
          undefined,
          options.targetSellerKey,
        ),
      ),
    );
  }

  return {
    publications: results.map((result) => result.publication),
    preview,
    createdCount: results.filter((result) => result.created).length,
  };
}
