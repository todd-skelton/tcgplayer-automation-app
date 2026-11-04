// Proves the Rust batch pricing worker against Node's on copies of the dev database (see twin.mjs):
// queues one pricing job in the base copy, lets Node's worker run it in one copy and the Rust
// worker in the other, then compares every row either wrote.
//
//   node scripts/parity/twin-pricing-worker.mjs <batch> <mode: full|errors|cached>
//
// A cached job prices from saved curves, so both workers must write the same values. A full or
// errors job reads TCGplayer once for each worker, minutes apart, so its numbers may differ as the
// market moved; then only what was written, and every value that is not a number, must match.
import { NODE, RUST, comparison, copy, drop, node, runUntil, rust, sql, started } from "./twin.mjs";

const [batchArg, mode = "cached"] = process.argv.slice(2);
const batch = Number(batchArg);
if (!Number.isInteger(batch) || !["full", "errors", "cached"].includes(mode)) {
  throw new Error("usage: twin-pricing-worker.mjs <batch> <full|errors|cached>");
}
const job = copy((base) => {
  const [id] = sql(
    base,
    `BEGIN;
     SELECT batch_number FROM inventory_batches WHERE batch_number = ${batch} FOR UPDATE;
     INSERT INTO inventory_batch_pricing_jobs (batch_number, priority, mode, status, config_json)
       SELECT batch_number, priority, '${mode}', 'queued', config_json FROM inventory_batch_pricing_jobs
        WHERE batch_number = ${batch} ORDER BY id DESC LIMIT 1 RETURNING id;
     UPDATE inventory_batches SET status = 'queued', updated_at = NOW() WHERE batch_number = ${batch};
     COMMIT;`,
  )
    .split("\n")
    .filter((line) => /^\d+$/.test(line) && Number(line) !== batch);
  if (!id) throw new Error(`Batch ${batch} has no pricing job to copy the configuration of`);
  return id;
});

const finished = (db) => {
  const [status] = sql(db, `SELECT status FROM inventory_batch_pricing_jobs WHERE id = ${job}`).trim().split("\n");
  return status === "completed" || status === "failed" ? status : undefined;
};
const nodeStatus = await runUntil(NODE, ...node("pricing-worker.server.ts"), {}, finished);
const rustStatus = await runUntil(RUST, ...rust, { PRICING_WORKER: "1" }, finished);

// Times differ by when each ran, and so does what is named by one: the worker's id, its
// processing time, and a publication candidate's key, which ends with when it was priced.
const check = comparison({ ignored: ["claimed_by", "processingTime", "candidate_key"], live: mode !== "cached" });
check.tables({
  inventory_batch_pricing_jobs: `SELECT to_jsonb(t) FROM inventory_batch_pricing_jobs t WHERE id = ${job}`,
  inventory_batches: `SELECT to_jsonb(t) FROM inventory_batches t WHERE batch_number = ${batch}`,
  inventory_batch_results: `SELECT to_jsonb(t) FROM inventory_batch_results t WHERE batch_number = ${batch} ORDER BY sku`,
  continuous_pricing_inventory: `SELECT to_jsonb(t) FROM continuous_pricing_inventory t WHERE last_batch_number = ${batch} ORDER BY sku`,
  inventory_strategy_pricing_curves: `SELECT to_jsonb(t) FROM inventory_strategy_pricing_curves t WHERE batch_number = ${batch} ORDER BY sku`,
  inventory_publications: `SELECT to_jsonb(t) FROM inventory_publications t WHERE pricing_job_id = ${job} ORDER BY id`,
  inventory_publication_items: `SELECT to_jsonb(i) FROM inventory_publication_items i JOIN inventory_publications p ON p.id = i.publication_id WHERE p.pricing_job_id = ${job} ORDER BY i.sku`,
});
// The listings each worker saw, kept per product and condition for the day (only which ones; the
// asks themselves move between the two reads).
check.same(
  "listing snapshots",
  (db) => `SELECT jsonb_build_object('product', s.product_id, 'variant', s.variant, 'language', s.language, 'condition', s.condition)
     FROM product_listing_snapshots s
    WHERE s.observed_at >= '${started[db]}'
      AND s.product_id IN (SELECT k.product_id FROM inventory_batch_items i JOIN skus k ON k.sku = i.sku WHERE i.batch_number = ${batch})
    ORDER BY s.product_id, s.variant, s.language, s.condition`,
);
console.log(`Batch ${batch}, ${mode} job ${job}: Node ${nodeStatus}, Rust ${rustStatus}`);
const differences = check.report();
drop();
process.exit(differences || nodeStatus !== rustStatus ? 1 : 0);
