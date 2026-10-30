// Writes the Node app's Inventory Strategy figures for a seller to target/node-strategy.json, for
// the Rust port's parity test (src/features/inventory_strategy/parity.rs). Remove with the Node app.
// Run: npx vite-node scripts/strategy-snapshot.ts [sellerKey]
import { writeFileSync } from "node:fs";
import { loadRealizedPerformance } from "~/features/inventory-strategy/services/realizedPerformance.server";
import { inventoryReinvestmentRepository } from "~/core/db";
import { loadCompleteReusableProceeds } from "~/features/inventory-economics/services/inventoryEconomics.server";
import { allocateReinvestmentTurnaround } from "~/features/inventory-strategy/domain/allocateReinvestmentTurnaround";
import { buildReinvestmentInput } from "~/features/inventory-strategy/services/reinvestmentTurnaround.server";

const seller = process.argv[2] ?? "8520a14f";
const now = new Date();
const { report, marginTrend } = await loadRealizedPerformance(seller, now);
// The reinvestment report as a rebuild makes it, without saving it.
const asOf = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
const proceeds = await loadCompleteReusableProceeds(seller);
const evidence = await inventoryReinvestmentRepository.findSourceEvidence(seller);
const { input } = buildReinvestmentInput(seller, asOf, proceeds, evidence);
const reinvestment = allocateReinvestmentTurnaround(input);
for (const unsupported of input.unsupportedPurchaseFunding) {
  reinvestment.excluded.push({ reason: unsupported.kind === "orphan"
    ? "Purchase-funding evidence without a matching current purchase cost"
    : `Purchase funding above current cost for ${unsupported.purchaseReference}`,
    count: 1, amountCents: unsupported.amountCents, currency: unsupported.currency });
}
writeFileSync("target/node-strategy.json", JSON.stringify({ seller, now: now.toISOString(), asOf, report, marginTrend, reinvestment, reinvestmentInput: input }));
console.log("windows", report.windows.length, "weeks", marginTrend.weeks.length);
process.exit(0);
