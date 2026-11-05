// Writes the Node app's Inventory Strategy figures for a seller to target/node-strategy.json, for
// the Rust port's parity test (src/features/inventory_strategy/parity.rs). Remove with the Node app.
// Run: npx vite-node scripts/strategy-snapshot.ts [sellerKey]
import { writeFileSync } from "node:fs";
import { loadRealizedPerformance } from "~/features/inventory-strategy/services/realizedPerformance.server";
import { inventoryReinvestmentRepository } from "~/core/db";
import { loadCompleteReusableProceeds } from "~/features/inventory-economics/services/inventoryEconomics.server";
import { allocateReinvestmentTurnaround } from "~/features/inventory-strategy/domain/allocateReinvestmentTurnaround";
import { buildReinvestmentInput } from "~/features/inventory-strategy/services/reinvestmentTurnaround.server";
import { selectTurnaround } from "~/features/inventory-strategy/domain/turnaroundStrategy";
import { inventoryStrategyTurnaroundRepository } from "~/core/db/repositories/inventoryStrategyTurnaround.server";
import { loadInventorySellingHistory } from "~/features/inventory-strategy/services/inventorySellingHistory.server";
import { inventoryStrategyRepository, pricingConfigRepository } from "~/core/db";
import { buildInventoryStrategyDashboard } from "~/features/inventory-strategy/services/inventoryStrategy";

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
// The turnaround for the seller and each line with samples, from that report, as the screen selects it.
const settings = await inventoryStrategyTurnaroundRepository.findForSeller(seller);
const lines = [null, ...new Set(reinvestment.samples.map((sample) => sample.productLineId))];
const turnaround = lines.map((line) => selectTurnaround(seller, line, settings, reinvestment, null, now));
// The selling history for the default scope and for one product line, second page of details.
const sellingHistory = await loadInventorySellingHistory(seller);
const lineScope = { windowDays: 365 as const, productLine: sellingHistory.availableProductLines[0] ?? null };
const sellingHistoryLine = await loadInventorySellingHistory(seller, { scope: lineScope, detailPage: 2 });
// The dashboard from the same snapshot and configuration, at the same instant.
const dashboard = buildInventoryStrategyDashboard(seller, await inventoryStrategyRepository.findSnapshot(seller), await pricingConfigRepository.get(), now);
writeFileSync("target/node-strategy.json", JSON.stringify({ seller, now: now.toISOString(), asOf, report, marginTrend, reinvestment, reinvestmentInput: input, turnaround, sellingHistory, lineScope, sellingHistoryLine, dashboard }));
console.log("windows", report.windows.length, "weeks", marginTrend.weeks.length);
process.exit(0);
