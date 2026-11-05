// Proves the Rust seller order history worker against Node's on copies of the dev database (see
// twin.mjs): each worker runs on its own copy from the same state, syncing the seller's orders from
// TCGplayer's order management search (reads only), replaying the FIFO queue and estimating batch
// costs, until its sync is complete, its queue is empty and it has written nothing for twenty
// seconds. Then every row of every table either wrote is compared. The two read TCGplayer minutes
// apart, so an order that changed in between differs; the report names it.
//
// Orders, their lines and FIFO revisions are compared by what names them (order number, SKU id,
// revision number), not by their ids: both workers assign those in an order set by timing (which
// order's transaction queued a SKU last, which sync step a replay falls between) and by lines read
// without an order, as Node's queries read them.
//
//   node scripts/parity/twin-seller-order-history.mjs
import { NODE, RUST, comparison, copy, drop, node, runUntil, rust, sql, started } from "./twin.mjs";

copy();

const QUIET = 20;
function settled() {
  let last;
  let since = 0;
  return (db) => {
    const [run, queued, writes] = JSON.parse(
      sql(
        db,
        `SELECT jsonb_build_array(
           coalesce((SELECT status || coalesce(':' || error, '') FROM seller_order_sync_runs
                      WHERE updated_at >= '${started[db]}' ORDER BY id DESC LIMIT 1), 'none'),
           (SELECT count(*) FROM inventory_fifo_replay_queue)::text,
           (SELECT sum(n_tup_ins + n_tup_upd + n_tup_del) FROM pg_stat_user_tables)::text)`,
      ),
    );
    if (writes !== last) [last, since] = [writes, 0];
    else since += 2;
    const finished = run === "complete" || (run.startsWith("incomplete:") && !run.includes("budget reached"));
    return finished && queued === "0" && since >= QUIET ? run : undefined;
  };
}
const nodeRun = await runUntil(NODE, ...node("seller-order-history-worker.server.ts"), {}, settled(), 60);
const rustRun = await runUntil(RUST, ...rust, { SELLER_ORDER_HISTORY_WORKER: "1" }, settled(), 60);

// The sync's claim is a fresh token each time.
const check = comparison({ ignored: ["claim_token", "claim_expires_at"] });
const order = "jsonb_build_object('order_number', o.order_number)";
const line = `${order} || jsonb_build_object('sku_id', l.order_line_sku_id)`;
check.writtenTables({
  seller_orders: "SELECT to_jsonb(o) - 'id' FROM seller_orders o ORDER BY o.seller_key, o.order_number",
  seller_order_revisions: `SELECT to_jsonb(r) - 'id' - 'order_id' || ${order}
     FROM seller_order_revisions r JOIN seller_orders o ON o.id = r.order_id ORDER BY o.order_number, r.revision_number`,
  seller_order_lines: `SELECT to_jsonb(s) - 'order_id' || ${order}
     FROM seller_order_lines s JOIN seller_orders o ON o.id = s.order_id ORDER BY o.order_number, s.sku_id`,
  inventory_fifo_lines: `SELECT to_jsonb(l) - 'id' - 'order_id' - 'current_revision_id' || ${order}
       || jsonb_build_object('current_revision', (SELECT v.revision_number FROM inventory_fifo_revisions v WHERE v.id = l.current_revision_id))
     FROM inventory_fifo_lines l JOIN seller_orders o ON o.id = l.order_id ORDER BY o.order_number, l.order_line_sku_id`,
  inventory_fifo_revisions: `SELECT to_jsonb(v) - 'id' - 'line_id' || ${line}
     FROM inventory_fifo_revisions v JOIN inventory_fifo_lines l ON l.id = v.line_id JOIN seller_orders o ON o.id = l.order_id
     ORDER BY o.order_number, l.order_line_sku_id, v.revision_number`,
  inventory_fifo_revision_allocations: `SELECT to_jsonb(a) - 'revision_id' || ${line} || jsonb_build_object('revision', v.revision_number)
     FROM inventory_fifo_revision_allocations a JOIN inventory_fifo_revisions v ON v.id = a.revision_id
     JOIN inventory_fifo_lines l ON l.id = v.line_id JOIN seller_orders o ON o.id = l.order_id
     ORDER BY o.order_number, l.order_line_sku_id, v.revision_number, a.supply_key`,
});
console.log(`Sync run: Node ${nodeRun}, Rust ${rustRun}`);
const differences = check.report();
drop();
process.exit(differences || nodeRun !== rustRun ? 1 : 0);
