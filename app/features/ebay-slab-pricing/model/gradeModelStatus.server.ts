import registry from "./gradeModelRegistry.json";
import type { SlabIdentity } from "../identity/slabIdentity";

// No runtime fit or provider read. An empty adoption registry deliberately preserves direct/manual pricing.
export function gradeModelStatus(identity: SlabIdentity | null) {
  return {
    status: "unavailable" as const,
    evaluationVersion: registry.version,
    reason:
      identity?.grading.grader === "PSA" && identity.grading.number === 1
        ? "PSA 1 collector pricing is not inferred from higher grades. Review its direct sales."
        : "No cross-grade model has enough verified, time-separated evidence for this cohort. Pricing uses direct sales and your review.",
  };
}
