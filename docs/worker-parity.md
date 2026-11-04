# Worker parity

Each Rust worker is proven against Node's by a twin run: `scripts/parity/twin.mjs` copies the dev
database once per worker, runs Node's worker on one copy and the Rust worker on the other from the
same state, then compares every row either wrote. Neither publishes: Seller Portal writes stay off,
and only the worker under test is started. Times, and anything named by one, are skipped. A worker
that reads TCGplayer reads it twice, minutes apart, so in a live run a number that differs is counted
as moved with the market; everything else must be equal.

Run one with a fresh `cargo build` and no other sessions on the dev database.

Rows are matched by what names them where ids are assigned in an order set by timing: orders by
order number, their lines and FIFO lines by SKU id, revisions by revision number.

| Worker | Script | Last run | Result |
| --- | --- | --- | --- |
| Batch pricing, cached job | `twin-pricing-worker.mjs 3516 cached` | 2026-11-04 | 20,706 values, 0 differ |
| Batch pricing, full job | `twin-pricing-worker.mjs 3471 full` | 2026-11-03 | same tables, rows and 17 listing snapshots; numbers moved with the market only |
| Continuous pricing scheduler | `twin-continuous-scheduler.mjs` | 2026-11-04 | one live refresh (802 listings) and one 50-SKU batch each; 56,471 values, 0 differ |
| Seller order history (sync, FIFO replay, cost estimates) | `twin-seller-order-history.mjs` | 2026-11-04 | sync complete on both (1,640 orders, 78 details read); 13 tables, 533,113 values, 0 differ |
| Slab evidence | not yet | | |
| Inventory publication | not yet; only with Seller Portal writes off | | |

The unit tests that replayed Node's answers from `.port-logs` (never committed) are being replaced
by these runs, worker by worker. Those still waiting on theirs are marked
`#[ignore = "... Node's run in .port-logs"]`.
