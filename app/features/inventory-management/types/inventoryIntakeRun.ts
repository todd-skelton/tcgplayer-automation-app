import {
  DEFAULT_ESTIMATED_COST_RATE,
  describeEstimatedCostRate,
  type EstimatedCostRate,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { formatCents } from "~/features/inventory-economics/domain/money";

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
  /** The batch's purchase cost as currently recorded, in cents, or null before any is recorded. */
  recordedCostCents: number | null;
  /** Receipt lots of the batch no purchase cost covers yet. */
  uncostedLotCount: number;
  /** Whether an entered purchase total, rather than an estimate, costs the batch. */
  hasEnteredCost: boolean;
  /** The rate the batch's estimate uses, or null for the default. */
  costRate: EstimatedCostRate | null;
}

/** How the batch is costed, for example "Cost $16.50 estimated at 60% of market less $0.50 per card". */
export function intakeRunCost(run: InventoryIntakeRun): string {
  if (run.hasEnteredCost) return `Cost ${formatCents(run.recordedCostCents ?? 0)} entered`;
  const rate = run.costRate
    ? describeEstimatedCostRate(run.costRate)
    : `the default ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`;
  return run.recordedCostCents === null || run.uncostedLotCount > 0
    ? `Cost not recorded yet; it will be estimated at ${rate} once every card has a market price`
    : `Cost ${formatCents(run.recordedCostCents)} estimated at ${rate}`;
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
