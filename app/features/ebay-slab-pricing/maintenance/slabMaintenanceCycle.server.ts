import { createHash } from "node:crypto";
import { queryOne } from "~/core/db/database.server";
import { getInventoryListing } from "../inventory/slabInventory.server";
import { getProviderConnections } from "../connections/providerConnections.server";
import { planSlabEvidence } from "../evidence/slabEvidenceRefresh.server";
import { evidenceKey } from "../evidence/evidenceRefreshProvider.server";
import {
  normalizeEvidenceSpec,
  type EvidenceSpec,
} from "../evidence/evidenceRefresh";
import {
  evidenceStatuses,
  requestEvidence,
} from "../evidence/evidenceRefreshStore.server";
import {
  calculateSlabRecommendation,
  getSlabRecommendation,
} from "../valuation/slabRecommendations.server";
import {
  claimMaintenance,
  maintenanceActive,
  maintenanceCandidates,
  maintenanceCheckpoint,
  maintenanceItemState,
  finishMaintenance,
} from "./slabMaintenanceStore.server";
// One rolling Chicago-date year, matching the review page default. Never import browser/client UI code into a worker.
export function maintenanceWindow(now = new Date()) {
  const to = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const from = new Date(`${to}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 365);
  return { from: from.toISOString().slice(0, 10), to };
}
export async function runSlabMaintenanceCycle() {
  const job = await claimMaintenance();
  if (!job) return null;
  const summary = {
    checked: 0,
    queued: 0,
    requested: 0,
    recalculated: 0,
    held: 0,
    waiting: 0,
    refreshBudget: job.refreshBudget,
  };
  try {
    const connections = await getProviderConnections();
    const available = new Set(
      connections
        .filter(
          (c) =>
            c.configured &&
            ["connected", "busy", "rate-limited", "unavailable"].includes(
              c.status,
            ),
        )
        .map((c) => c.provider),
    );
    const candidates = await maintenanceCandidates(job),
      window = maintenanceWindow();
    for (const candidate of candidates) {
      if (!(await maintenanceActive(job))) break;
      const row = await getInventoryListing(candidate.id);
      if (!row || row.state !== "active") continue;
      const previous = await maintenanceItemState(row.id);
      let recommendationId = previous?.recommendationId ?? null,
        inputKey: string | null = null,
        outcome = "review-required",
        reason = "confirm-listing-identity",
        waiting = false;
      try {
        const identity = row.identity;
        if (
          identity?.status === "confirmed" &&
          identity.identity &&
          !row.reviewReasons.some((r) => r !== "certificate-required") &&
          row.snapshot.quantity === 1 &&
          row.snapshot.format === "fixed-price" &&
          !row.variationKey
        ) {
          const latest = await queryOne<{ id: string }>(
            "SELECT id FROM slab_recommendations WHERE slab_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [identity.id],
          );
          const recommendation = latest
            ? await getSlabRecommendation(latest.id)
            : null;
          recommendationId = recommendation?.id ?? null;
          const plan = planSlabEvidence([identity], window, job.includeSupply);
          const calcSpecs: EvidenceSpec[] =
            recommendation?.calculation.evidence.map((e) =>
              normalizeEvidenceSpec(
                e.spec.kind === "alt-sales" || e.spec.kind === "ebay-sales"
                  ? { ...e.spec, window }
                  : e.spec,
              ),
            ) ?? [];
          const specs = [
            ...new Map(
              [...calcSpecs, ...plan.requests].map((spec) => [
                evidenceKey(spec),
                spec,
              ]),
            ).values(),
          ];
          const keys = specs.map(evidenceKey),
            statuses = await evidenceStatuses(keys),
            byKey = new Map(statuses.map((s) => [s.key, s]));
          const requested: EvidenceSpec[] = [];
          for (const spec of specs) {
            const state = byKey.get(evidenceKey(spec));
            if (requested.length + summary.requested >= job.refreshBudget)
              break;
            if (
              available.has(
                spec.kind.startsWith("alt-") ? "alt" : "ebayResearch",
              ) &&
              (!state || state.stale) &&
              state?.state !== "queued" &&
              state?.state !== "running"
            )
              requested.push(spec);
          }
          if (requested.length && (await maintenanceActive(job))) {
            const refreshed = await requestEvidence(requested, { priority: 0 });
            summary.requested += requested.length;
            summary.queued += refreshed.filter(
              (s) => s.state === "queued",
            ).length;
            for (const status of refreshed) byKey.set(status.key, status);
          }
          const selected = calcSpecs.map((spec) =>
            byKey.get(evidenceKey(spec)),
          );
          const ready =
            selected.length > 0 &&
            selected.every(
              (s) => s?.latestRevision && !s.stale && s.state === "idle",
            );
          if (!recommendation) {
            reason = "save-seller-context-before-repricing";
          } else if (recommendation.override) {
            reason = "reviewed-price-held";
          } else if (!ready) {
            outcome = "waiting";
            reason = "fresh-selected-evidence-required";
            waiting = true;
          } else if (
            row.snapshot.price.currency !== "USD" ||
            (row.snapshot.shipping.amount !== null &&
              row.snapshot.shipping.currency !== "USD")
          ) {
            reason = "pricing-currency-unresolved";
          } else {
            const seller = {
              ...recommendation.calculation.seller,
              currentAsk: row.snapshot.price.amount,
              shippingCharged: row.snapshot.shipping.amount,
            };
            const revisionIds = [
              ...new Set(selected.map((s) => s!.latestRevision!)),
            ].sort();
            inputKey = createHash("sha256")
              .update(
                JSON.stringify([
                  row.revision,
                  identity.revision,
                  revisionIds,
                  recommendation.calculation.policy,
                  seller,
                ]),
              )
              .digest("hex");
            if (previous?.inputKey === inputKey && recommendation.current) {
              outcome = "unchanged";
              reason = "fresh-inputs-unchanged";
            } else if (await maintenanceActive(job)) {
              const calculated = await calculateSlabRecommendation(
                {
                  slabId: identity.id,
                  identityRevision: identity.revision,
                  revisionIds,
                  policy: recommendation.calculation.policy,
                  seller,
                },
                undefined,
                { expectedRecommendationId: recommendation.id },
              );
              recommendationId = calculated.id;
              summary.recalculated++;
              outcome = calculated.calculation.ask.requiresReview
                ? "review-required"
                : "recalculated";
              reason = calculated.calculation.ask.requiresReview
                ? "recommendation-needs-review"
                : "publication-remains-disabled";
            }
          }
          // Continue promptly after scheduled reads; unrelated sources do not block already fresh selected evidence.
          waiting ||= [...byKey.values()].some(
            (s) => s.state === "queued" || s.state === "running",
          );
          waiting ||= specs.some(
            (spec) =>
              available.has(
                spec.kind.startsWith("alt-") ? "alt" : "ebayResearch",
              ) &&
              (!byKey.get(evidenceKey(spec)) ||
                byKey.get(evidenceKey(spec))!.stale),
          );
        }
      } catch {
        outcome = "review-required";
        reason = "recalculation-unavailable";
      }
      if (!(await maintenanceActive(job))) break;
      await maintenanceCheckpoint(job, {
        inventoryId: row.id,
        inventoryRevision: row.revision,
        identityRevision: row.identity?.revision ?? null,
        inputKey,
        recommendationId,
        outcome,
        reason,
        waiting,
      });
      summary.checked++;
      if (outcome === "review-required") summary.held++;
      if (waiting) summary.waiting++;
    }
    await finishMaintenance(job, summary);
    return summary;
  } catch {
    await finishMaintenance(job, summary, "maintenance-unavailable");
    return summary;
  }
}
