// Writes the Node app's Inventory Strategy figures for a seller to target/node-strategy.json, for
// the Rust port's parity test (src/features/inventory_strategy/parity.rs). Remove with the Node app.
// Run: npx vite-node scripts/strategy-snapshot.ts [sellerKey]
import { writeFileSync } from "node:fs";
import { loadRealizedPerformance } from "~/features/inventory-strategy/services/realizedPerformance.server";

const seller = process.argv[2] ?? "8520a14f";
const now = new Date();
const { report, marginTrend } = await loadRealizedPerformance(seller, now);
writeFileSync("target/node-strategy.json", JSON.stringify({ seller, now: now.toISOString(), report, marginTrend }));
console.log("windows", report.windows.length, "weeks", marginTrend.weeks.length);
process.exit(0);
