// Node's half of src/features/batch_pricing/saved_curves.rs's resolver test: resolves a sample of
// the dev database's saved curves (each model version, and curves of no version) through Node's
// cached resolver, at the percentile each run used and at 30, and writes the curves with Node's
// answers. Reads only.
//
//   TZ=UTC WORKERS_RUN_IN_PROCESS=false npx vite-node scripts/parity/saved-curves.ts <out.json>
//   SAVED_CURVES=<out.json> cargo test --lib saved_curves_resolve_as_node_s_resolver_does -- --ignored
const [outArg] = process.argv.slice(2);
if (!outArg) throw new Error("usage: saved-curves.ts <out.json>");
if (process.env.WORKERS_RUN_IN_PROCESS !== "false") {
  throw new Error("Set WORKERS_RUN_IN_PROCESS=false so no worker starts in this process.");
}
if (process.env.TZ !== "UTC") throw new Error("Set TZ=UTC, as the production containers run.");

export {};

const { writeFileSync } = await import("node:fs");
const { query } = await import("~/core/db/database.server");
const { createCachedSuggestedPriceResolver } = await import(
  "~/features/pending-inventory/services/inventoryBatchPricing.server"
);

type Curve = { sku: number; details: Record<string, unknown> & { percentileUsed?: number } };
// The first curves of each model version by SKU, so a recording is small and the same each time.
const curves = await query<Curve>(
  `SELECT sku, details FROM (
     SELECT sku, pricing_details_json AS details,
            ROW_NUMBER() OVER (PARTITION BY pricing_details_json->>'pricingModelVersion' ORDER BY sku) AS n
       FROM inventory_strategy_pricing_curves
      WHERE pricing_details_json IS NOT NULL
   ) sample WHERE n <= 12 ORDER BY sku`,
);
const resolve = createCachedSuggestedPriceResolver(new Map(curves.map((c) => [c.sku, c.details as never])));
const answers = [];
for (const curve of curves) {
  for (const percentile of [...new Set([curve.details.percentileUsed ?? 65, 30])]) {
    const result = await resolve({ tcgplayerId: String(curve.sku), percentile } as never);
    answers.push({ sku: curve.sku, percentile, result });
  }
}
writeFileSync(outArg, JSON.stringify({ curves, answers }, null, 2) + "\n");
console.log(`Resolved ${curves.length} curves, ${answers.length} answers; wrote ${outArg}`);
process.exit(0);
