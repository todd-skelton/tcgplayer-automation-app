export type InventoryPublicationSourceType =
  | "pending_inventory"
  | "seller"
  | "csv"
  | "continuous";

export type InventoryPublicationMethod = "staged_delta" | "direct_absolute";

export type InventoryPublicationStatus =
  | "planned"
  | "staging"
  | "staged"
  | "publishing"
  | "published"
  | "ambiguous"
  | "failed"
  | "rolled_back";

export type InventoryPublicationItemStatus =
  | "planned"
  | "manual_review"
  | "superseded"
  | "published"
  | "ambiguous"
  | "failed";

export type InventoryPublicationEligibilityReason =
  | "automatic_publishing_disabled"
  | "source_not_enabled"
  | "pricing_error"
  | "pricing_warning"
  | "missing_price"
  | "invalid_price"
  | "missing_previous_price"
  | "unchanged_price"
  | "below_minimum_change"
  | "candidate_stale"
  | "invalid_quantity_delta"
  | "missing_product_metadata"
  | "csv_quantity_delta_requires_review"
  | "inventory_delta_already_planned"
  | "inventory_delta_ambiguous"
  | "inventory_delta_already_consumed";

export interface InventoryPublicationPolicy {
  automaticPublishingEnabled: boolean;
  automaticSources: Record<InventoryPublicationSourceType, boolean>;
  allowWarnings: boolean;
  maximumCandidateAgeMs: number;
  minimumAbsolutePriceChange: number;
  minimumRelativePriceChangePercent: number;
  stagedMicroBatchMaximum: number;
  stagedFlushWindowMs: number;
}

export const DEFAULT_INVENTORY_PUBLICATION_POLICY: InventoryPublicationPolicy =
  {
    automaticPublishingEnabled: false,
    automaticSources: {
      pending_inventory: false,
      seller: false,
      csv: false,
      continuous: false,
    },
    allowWarnings: false,
    maximumCandidateAgeMs: 60 * 60 * 1000,
    minimumAbsolutePriceChange: 0.01,
    minimumRelativePriceChangePercent: 0,
    stagedMicroBatchMaximum: 250,
    stagedFlushWindowMs: 60 * 1000,
  };

export interface InventoryPublicationCandidate {
  sourceType: InventoryPublicationSourceType;
  batchNumber: number;
  sku: number;
  price?: number | null;
  previousPrice?: number | null;
  quantityDelta: number;
  isNewInventory?: boolean;
  pricedAt: Date;
  errors?: readonly string[];
  warnings?: readonly string[];
  inventoryDeltaConsumed?: boolean;
}

export interface InventoryPublicationEligibilityDecision {
  eligible: boolean;
  reasons: InventoryPublicationEligibilityReason[];
  roundedPrice?: number;
  roundedPreviousPrice?: number;
  absolutePriceChange?: number;
  relativePriceChangePercent?: number;
}

export interface InventoryPublicationItem {
  id: number;
  publicationId: number;
  candidateKey: string;
  inventoryDeltaKey: string | null;
  batchNumber: number | null;
  sku: number;
  productId: number;
  productLine: string;
  setName: string;
  productName: string;
  condition: string;
  previousPrice: number | null;
  desiredPrice: number;
  quantityDelta: number;
  observedQuantity: number | null;
  desiredAbsoluteQuantity: number | null;
  pricedAt: Date;
  eligibilityReasons: InventoryPublicationEligibilityReason[];
  status: InventoryPublicationItemStatus;
  errorCode: string | null;
  errorMessage: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryPublication {
  id: number;
  planningKey: string;
  batchNumber: number | null;
  pricingJobId: number | null;
  method: InventoryPublicationMethod;
  sourceType: InventoryPublicationSourceType;
  sellerKey: string | null;
  status: InventoryPublicationStatus;
  stagedPricingUploadId: number | null;
  config: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  stagedAt: Date | null;
  publishingAt: Date | null;
  publishedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: InventoryPublicationItem[];
}

export interface CreateInventoryPublicationItem {
  candidateKey: string;
  inventoryDeltaKey?: string | null;
  batchNumber?: number | null;
  sku: number;
  productId: number;
  productLine: string;
  setName: string;
  productName: string;
  condition: string;
  previousPrice?: number | null;
  desiredPrice: number;
  quantityDelta: number;
  observedQuantity?: number | null;
  desiredAbsoluteQuantity?: number | null;
  pricedAt: Date;
  eligibilityReasons?: InventoryPublicationEligibilityReason[];
  status?: InventoryPublicationItemStatus;
}

export interface CreateInventoryPublication {
  planningKey: string;
  batchNumber?: number | null;
  pricingJobId?: number | null;
  method: InventoryPublicationMethod;
  sourceType: InventoryPublicationSourceType;
  sellerKey?: string | null;
  config?: Record<string, unknown>;
  items: CreateInventoryPublicationItem[];
}

export interface InventoryPublicationItemOutcome {
  itemId: number;
  status: Extract<
    InventoryPublicationItemStatus,
    "published" | "ambiguous" | "failed"
  >;
  errorCode?: string | null;
  errorMessage?: string | null;
}

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

export interface InventoryBatchPublicationApiResponse {
  preview: InventoryBatchPublicationPreview | null;
  publications: InventoryPublication[];
}
