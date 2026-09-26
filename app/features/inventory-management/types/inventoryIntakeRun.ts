export type InventoryIntakeWorkflow = "price_only" | "publish";

export interface IntakePublicationTarget {
  sellerKey: string;
  publicationSellerKey: string;
  canPublish: boolean;
  publishingUnavailableReason: string | null;
  publicationPaused: boolean;
}

export interface InventoryIntakeRun {
  batchNumber: number;
  workflow: InventoryIntakeWorkflow;
  planningStatus: "waiting" | "planned" | "needs_review";
  planningError: string | null;
  pricingStatus: "queued" | "pricing" | "completed" | "failed";
  pricingError: string | null;
  itemCount: number;
  quantity: number;
  publishedCount: number;
  publishingCount: number;
  reviewCount: number;
  createdAt: string;
}

export function intakeRunStatus(run: InventoryIntakeRun): string {
  if (run.pricingStatus === "failed") return "Pricing failed";
  if (run.pricingStatus === "queued") return "Queued";
  if (run.pricingStatus === "pricing") return "Pricing";
  if (run.publishedCount === run.itemCount && run.itemCount > 0)
    return "Published";
  if (run.publishingCount > 0) return "Awaiting publication";
  if (run.reviewCount > 0 || run.planningStatus === "needs_review")
    return "Needs review";
  if (run.workflow === "price_only") return "Priced; review before publishing";
  if (run.planningStatus === "waiting") return "Awaiting publication";
  return run.publishedCount === run.itemCount ? "Published" : "Needs review";
}
