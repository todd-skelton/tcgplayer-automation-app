// Writes the Node app's complete reusable proceeds for a seller to target/node-proceeds.json, for the
// Rust ledger's parity test (src/features/inventory_economics/ledger/proceeds.rs). Remove with the Node app.
// Run: npx vite-node scripts/ledger-proceeds-snapshot.ts [sellerKey]
import { loadCompleteReusableProceeds } from "~/features/inventory-economics/services/inventoryEconomics.server";
import { writeFileSync } from "node:fs";
const result = await loadCompleteReusableProceeds(process.argv[2] ?? "8520a14f");
writeFileSync("target/node-proceeds.json", JSON.stringify(result));
console.log("sales", result.sales.length, "unknown", result.unknownProceedsOrderCount);
process.exit(0);
