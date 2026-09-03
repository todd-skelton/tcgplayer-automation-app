# Pricing Operations and Scaling Plan

## Purpose

Keep manual pricing understandable as continuous pricing grows, price newly added inventory before routine repricing, bound every operator-facing collection, and recover safely from transient or item-specific failures.

This plan is durable: it defines the operating model, invariants, rollout order, and acceptance criteria rather than only describing the first implementation.

## Production findings (2026-08-07)

- Continuous pricing completed its first full inventory cycle, with completed batches averaging about 24 minutes and a maximum near 35 minutes.
- The scheduler pre-created many routine batches. Because pricing workers claimed jobs strictly by creation time, a one-SKU new-inventory batch waited more than five hours behind routine work.
- The manual Batch Pricer loaded every historical batch, including automatic continuous batches.
- Continuous Pricing loaded and rendered all 1,174 tracked SKUs. This cost grows linearly with inventory.
- 143 pricing rows encountered clustered transient HTTP 500 or TLS disconnect errors. They became manual-review rows but were not due again until the normal daily interval.
- Two staged uploads contained six identifiable product-detail mismatches. The portal accepted 61 other rows, but the conservative whole-upload rollback discarded all 67 rows.
- Published item outcomes were otherwise confirmed: 39 publications and 1,080 item updates completed with no failed or ambiguous outcomes among those published.

## Operating model

### Manual pricing

The Batch Pricer is the operator workspace for batches created from Pending Inventory, Seller Pricer, and CSV Pricer. Its default collection is bounded to the newest 100 manual batches. A direct batch URL remains available after a batch falls outside that window.

Automatic continuous batches do not appear in the manual selector. Continuous Pricing owns a compact, bounded recent-run history for automatic work.

### Automatic continuous pricing

Continuous Pricing owns schedule configuration, aggregate health, searchable inventory controls, and the newest 25 automatic batches. Inventory controls use server-side search, state filters, and pagination; the route never loads the complete inventory projection.

### Work priority

Pricing jobs are claimed by descending priority, then by creation time and ID for deterministic FIFO behavior within a class.

| Priority | Work                                               | Reason                                                                                |
| -------: | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
|      300 | Pending Inventory                                  | Newly entered stock must be priced before it can be managed safely.                   |
|      200 | Operator-created Seller/CSV work                   | Explicit operator actions stay responsive.                                            |
|      100 | Never-priced continuous SKUs and transient retries | New seller inventory and recoverable failures should not wait behind a routine cycle. |
|        0 | Routine continuous repricing                       | Background maintenance yields to all intentional or recovery work.                    |

Re-queuing an expired lease preserves the job's original priority.

### Backpressure

The scheduler may keep at most one routine continuous job queued. It may schedule a priority continuous batch containing never-priced or retry-due SKUs even when routine work is queued. This bounds future queue growth without deleting existing work.

Due selection orders priority candidates first and then uses `next_price_at, sku` for stable fairness. Scheduling remains transactional and advances each selected SKU's next due time, preventing duplicate active batches.

### Failure recovery

- A successful price resets the consecutive pricing failure count.
- A pricing row with an actual error message becomes due for retry after 15 minutes and receives recovery priority.
- Other warnings, including a policy falling back to its percentile or a reference price, remain on the normal pricing interval.
- Three consecutive pricing failures pause the SKU for review.
- A successful result that could only keep the current price, because the SKU has no usable sales history, market price, or listing, pauses the SKU with a no-data reason. An inventory refresh that brings a market price clears that pause.
- A seller portal upload may continue only when the portal's reported successful count plus an exact, parseable set of product-detail mismatch SKU IDs accounts for every submitted row. Known rejected SKUs are marked failed and paused; accepted rows proceed to live publication.
- Any unaccounted upload mismatch remains a full rollback. Ambiguous move-to-live outcomes retain the existing reconciliation pause.

## Data and API changes

1. Add `priority INTEGER NOT NULL DEFAULT 0` to `inventory_batch_pricing_jobs` and a claim index on `(status, priority DESC, created_at, id)`.
2. Include `continuous` in the batch source type.
3. Add bounded batch repository queries by source and limit.
4. Add a continuous inventory page query with `q`, `state`, `page`, a fixed page size of 50, and a total count.
5. Add queue-depth and priority-due queries used by the scheduler's backpressure decision.
6. Return an explicit `backlogged` scheduler result when routine due work is intentionally deferred.

## Delivery slices

1. **Bounded ownership:** separate manual and automatic histories; keep direct batch access.
2. **Priority and backpressure:** migrate the job queue, assign priorities at creation, and claim by priority.
3. **Inventory scale:** add server-side search/filter/pagination and render only one inventory page.
4. **Recovery:** retry transient pricing errors quickly and isolate exactly identified upload rejects.
5. **Operations:** verify migrations, focused tests, full tests, type checks, deployment health, queue ordering, UI bounds, and publication outcomes.

## Acceptance criteria

- A Pending Inventory job is claimed before already queued routine continuous jobs once the active worker becomes available.
- A newly observed continuous SKU or retry-due SKU is selected before routine due SKUs and receives priority 100.
- The scheduler cannot create an unbounded routine queue.
- The Batch Pricer returns no continuous batches and loads at most 100 records.
- Continuous Pricing loads at most 50 inventory records and at most 25 automatic history records per request.
- Search matches SKU, product, set, condition, and product line; state filters cover all, enabled, needs review, in stock, out of stock, and due.
- A transient error is due after 15 minutes, succeeds by resetting its failure count, and pauses after the third consecutive failure.
- An exactly identified product-detail mismatch does not prevent accepted rows from moving live; the rejected SKU is recorded and paused.
- An unexplained stage count mismatch still rolls back.
- Existing manual pricing, direct batch loading, lease recovery, automatic publication, and reconciliation behavior remain covered by tests.

## Rollout and observation

1. Apply the additive migration before application code begins writing priorities.
2. Deploy one application revision containing the migration-compatible reads and writes.
3. Backfill only queued never-priced and recovery work; let existing routine priority-zero work drain naturally without deleting it.
4. Confirm that no more than one new routine continuous job is queued and that a priority job jumps ahead at the next claim.
5. Watch pricing error clusters, paused SKUs, publication item failures, ambiguous publications, and queue age during the first complete interval.
6. Treat sustained queue age greater than the configured pricing interval as a capacity signal. Increase worker capacity or adjust interval/batch size; do not remove backpressure.

## Future continuous-job evolution

The queue model supports a continuously cycling service without coupling operator UI to batch volume. Batches remain immutable audit and retry units, while the inventory projection remains the scheduling source of truth. If throughput later requires multiple pricing workers, priority/FIFO ordering and row locking remain valid; concurrency limits can be added per seller without changing the UI or batch contract.

## Execution record

- [x] Audit production timing, queue shape, pricing failures, and publications.
- [x] Define ownership, priority, backpressure, pagination, and recovery invariants.
- [x] Implement bounded manual and automatic history.
- [x] Implement priority scheduling and transient retry.
- [x] Implement continuous inventory search/filter/pagination.
- [x] Implement exact seller metadata reject isolation.
- [x] Run full verification and production validation.

### Production validation (2026-08-07)

- Migrations 017 and 018 applied successfully.
- The app, database, pricing worker, publication worker, and scheduler are healthy with no post-deploy errors.
- Manual batch loading returned three manual batches and no continuous batches.
- Continuous Pricing rendered 50 inventory controls, one filtered Greninja result, zero current needs-review results, and exactly 25 recent automatic runs.
- The scheduler created no additional backlog; batch 142 remained the newest batch after deployment.
- Recovery batches 137 and 138 were backfilled to priority 100 and moved ahead of seven priority-zero routine batches.
- Full tests, route type generation, TypeScript validation, and the production application/worker build passed.
