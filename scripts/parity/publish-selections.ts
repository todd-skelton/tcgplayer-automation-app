// Records Node's publish route's planning (POST /api/inventory-batches/:batch/publications calls
// planInventoryBatchPublications with the saved policy and the continuous pricing seller) over dev
// batches, for `inventory_publication::plan`'s `selections_plan_as_node_plans`: received, csv,
// continuous and strategy batches, selections, a selection planned twice, a split at a smaller
// maximum, no seller, no maximum, stale candidates and a missing batch.
//
//   node scripts/parity/publish-selections.mjs
//
// The runner gives each case its own fresh copy of the dev database (publish_parity), so no case
// sees another's publications. Planning only saves publications; no worker runs in this process and
// nothing is posted to Seller Portal. Appends the case to tests/fixtures/node/publication/publish.json.
import { readFileSync, writeFileSync } from "node:fs";

if (!process.env.DATABASE_URL?.endsWith("/publish_parity")) throw new Error("Run through scripts/parity/publish-selections.mjs");
const OUT = "tests/fixtures/node/publication";
const [index, at] = [Number(process.argv[2]), process.argv[3]];
const theCase = JSON.parse(readFileSync(`${OUT}/publish-cases.json`, "utf8"))[index];
const { getPool, query } = await import("~/core/db/database.server");
const { inventoryPublicationSettingsRepository } = await import("~/core/db");
const { planInventoryBatchPublications } = await import("~/features/inventory-publication/services/inventoryBatchPublication.server");
const pool = getPool();
if (theCase.setup) await pool.query(theCase.setup);
const before = (await query<{ max: string }>("SELECT COALESCE(max(id), 0)::text AS max FROM inventory_publications"))[0].max;
const skus: number[] | null =
  theCase.skus ??
  (theCase.pick
    ? (await query<{ sku: number }>("SELECT sku FROM inventory_batch_results WHERE batch_number = $1 ORDER BY sku LIMIT $2", [theCase.batch, theCase.pick])).map((r) => r.sku)
    : null);
const answers = [];
for (let n = 0; n < (theCase.times ?? 1); n++) {
  // As the route does: the saved settings, read for each request.
  const configuration = await inventoryPublicationSettingsRepository.get();
  try {
    const result = await planInventoryBatchPublications(theCase.batch, {
      policy: configuration.settings.policy,
      selectedSkus: skus ?? undefined,
      targetSellerKey: configuration.settings.continuousPricing.sellerKey || undefined,
      now: new Date(at),
    });
    answers.push({ status: result.createdCount > 0 ? 201 : 200, publications: result.publications.length, created: result.createdCount });
  } catch (error) {
    answers.push({ status: 500, error: String(error) });
  }
}
const capture = readFileSync(`${OUT}/publish-capture.sql`, "utf8");
const row = (await pool.query(capture, [before])).rows[0];
const captured = JSON.parse(Object.values(row)[0] as string);
const out = `${OUT}/publish.json`;
let recorded: unknown[] = [];
try {
  recorded = JSON.parse(readFileSync(out, "utf8"));
} catch {
  recorded = [];
}
recorded[index] = { name: theCase.name, at, skus, answers, captured };
writeFileSync(out, JSON.stringify(recorded, null, 1) + "\n");
console.log(`${theCase.name}: ${JSON.stringify(answers)}, ${captured.length} saved`);
await pool.end();
