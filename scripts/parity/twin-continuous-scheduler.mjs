// Proves the Rust continuous pricing scheduler against Node's on copies of the dev database (see
// twin.mjs): each scheduler runs on its own copy from the same state, refreshing the seller's
// inventory from TCGplayer when it is stale and queueing what is due, until it has nothing more to
// queue. Then the refreshes, the tracked inventory, and the batches, items and jobs each queued are
// compared. The two read TCGplayer minutes apart, so numbers may move with the market.
//
//   node scripts/parity/twin-continuous-scheduler.mjs
import { setTimeout as sleep } from "node:timers/promises";
import { NODE, RUST, comparison, copy, drop, node, runUntil, rust, sql, started } from "./twin.mjs";

copy();

// Done once the cycle has refreshed (or failed to) and queued nothing new for twenty seconds.
const QUIET = 20;
function quiet() {
  let last;
  let since = 0;
  return (db) => {
    const [refreshes, batches] = sql(
      db,
      `SELECT (SELECT count(*) FROM continuous_pricing_refreshes WHERE started_at >= '${started[db]}' AND status <> 'running')
              || ' ' || (SELECT count(*) FROM inventory_batches WHERE source_type = 'continuous' AND created_at >= '${started[db]}')`,
    ).trim().split(" ").map(Number);
    if (!refreshes) return undefined;
    if (batches !== last) [last, since] = [batches, 0];
    else since += 2;
    return since >= QUIET ? batches : undefined;
  };
}
const [nodeCommand, nodeArgs] = node("continuous-pricing-scheduler.server.ts");
const nodeBatches = await runUntil(NODE, nodeCommand, nodeArgs, {}, quiet(), 20);
await sleep(0);
const rustBatches = await runUntil(RUST, ...rust, { CONTINUOUS_PRICING_SCHEDULER: "1" }, quiet(), 20);

const since = (db) => started[db];
const batches = (db) => `SELECT batch_number FROM inventory_batches WHERE source_type = 'continuous' AND created_at >= '${since(db)}'`;
const check = comparison({ live: true });
check.tables({
  continuous_pricing_refreshes: (db) => `SELECT to_jsonb(t) FROM continuous_pricing_refreshes t WHERE started_at >= '${since(db)}' ORDER BY started_at`,
  continuous_pricing_inventory: "SELECT to_jsonb(t) FROM continuous_pricing_inventory t ORDER BY seller_key, sku",
  inventory_batches: (db) => `SELECT to_jsonb(t) FROM inventory_batches t WHERE batch_number IN (${batches(db)}) ORDER BY batch_number`,
  inventory_batch_items: (db) => `SELECT to_jsonb(t) FROM inventory_batch_items t WHERE batch_number IN (${batches(db)}) ORDER BY batch_number, sku`,
  inventory_batch_pricing_jobs: (db) => `SELECT to_jsonb(t) FROM inventory_batch_pricing_jobs t WHERE batch_number IN (${batches(db)}) ORDER BY batch_number, id`,
});
console.log(`Continuous batches queued: Node ${nodeBatches}, Rust ${rustBatches}`);
const differences = check.report();
drop();
process.exit(differences || nodeBatches !== rustBatches ? 1 : 0);
