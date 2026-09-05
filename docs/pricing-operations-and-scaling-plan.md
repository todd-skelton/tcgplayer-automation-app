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

## Forecast grading

Realized sales over the four weeks to 2026-09-03 showed the curve's sell-time forecast is overconfident. Listings forecast to sell within a week sold 29% of the time in three weeks, and listings forecast beyond 120 days sold 13%. A buyer-choice model fitted to the same sales explains the shape: a listing's sale rate is the card's total sale rate, softened by the number of competing sellers, scaled by the card's share of the buyer's effective price once the $1.49 small-order shipping fee is included.

Every modeled result with observed listings now records that forecast at the listed price as `buyerChoiceForecast`, tagged with the calibration that produced it, beside the curve's own forecast. Its inputs are read from the persisted curve, so a refit needs no new data. Pricing does not read it.

The curve's buyer interval pools sales of every condition, and held out against the following month that pooled rate ranked which slow SKUs would sell barely better than chance, while the SKU's own yearly sale rate ranked them well. Every modeled result now also records `conditionRateForecast`: the median wait at the listed price from a year of the SKU's own weekly sales, weighted toward the last quarter, read from the annual price history that pricing fetches once per product. Pricing does not read it either. The inventory strategy page grades all three forecasts against realized sales of the continuously priced inventory over the newest complete cohort, at a 14, 21, or 28 day horizon. The policy adopts the better forecast only after that comparison, and a randomized price test must follow, because realized sales cover only the prices already listed.

## Price floor

The floor was market price less the fee. Realized sales showed it held liquid cards above where they trade, because the market price is a trailing average, and it was also the only thing stopping the model from listing a near-mint card at a damaged price when the card had no near-mint sales and the curve was built from other conditions. Three changes replace it:

- Condition normalization falls back to the ratio of the sibling SKUs' market prices, read from the annual price history, when the listed condition has too few sales to fit an exponent. Held out, that ratio predicted a condition's price with 14% median error against 33% for the neutral fallback it replaces. The ratios form one value ladder per card: a condition with no market price takes its nearest priced neighbour's value, the closest better one else the closest worse, recorded as `conditionNormalization.anchorCondition`; no condition is valued above a better one, the better one's price winning where the market prices disagree since it rests on far more sales; and every value is bounded to the reach of the fitted exponent. The same ladder serves whichever condition is being priced, so every condition's curve is the one card curve rescaled, never a different shape. Results record the method in `conditionNormalization`.
- The floor is the market-based minimum, lowered to the SKU's own-condition low sale in the last 90 days or, when the store's own listing is excluded from the search, to the second-cheapest competing ask in the same condition; both are recorded as `priceEvidence`. Own evidence releases the floor on liquid cards and keeps it where the card has none; without a market price there is no floor, as before. The cheapest ask is skipped because one listing in ten is mis-conditioned or thrown away; asks above the second are the ones that run insane.
- A curve whose fastest point waits beyond a year holds the current price under every policy, or a reference price when the SKU has none, instead of trading price for a marginally shorter wait. The strategy page and the shadow plan leave such curves out for the same reason.

## Pooled supply

Buyers want the card and weigh condition against price, so a listing competes with every seller of the product, not only sellers of its own condition. Since `pooled-supply-v1`, the competing sellers behind `listingsCount` and `storeWinShare` are counted across every condition of the product, variant, and language, with each ask scaled onto the listed condition by the same multipliers that scale sales: a better condition's ask competes at or below its own price, a worse condition's only once it is cheap enough to be worth the downgrade. One listings fetch per product serves every condition. Before this, demand was pooled across conditions while supply was counted per condition, which made scarce lower conditions look like fast sales at high prices and let the profit-per-day policy list them above Near Mint. The buyer-choice calibration predates the pooled count and reads a larger competitor number than it was fitted on until it is refit; forecast grading only admits results priced under the current model version, so the pooled cohort is graded on its own.
## Sales ledgers

The latest sales endpoint returns the last hundred sales of a product, a rolling window of about ninety days, and each SKU is priced about once a day at ten seconds a request, so pricing already downloads the sale history of everything in stock and threw it away. Since migration 022 every response is kept in `product_sales`, one row per sale, the same sale seen again ignored. Since migration 023 the annual price history pricing fetches once per product is kept in `product_weekly_sales`, one row per SKU and traded week with the sale count and the lowest and highest price paid, a year of every condition's direct sales; and the competing listings pricing fetches are summarized per condition per day in `product_listing_snapshots` with the seller count and two cheapest delivered asks. Recording is best effort and never delays a price, and none of it costs a request. Without the authenticated cookie the sales endpoint returns only five sales, which is what an unauthenticated probe sees.

The ledgers exist so that condition normalization can be tested forward on direct sales rather than on TCGplayer's market price, which is a trailing average of up to 25 sales of one condition. `npm run evaluate:condition-ladder` runs that test over weekly cutoffs: everything before a cutoff is evidence, recorded sales in the two weeks after are the truth, and each condition is scored both as seen and with its own evidence removed. Four candidates build the card's value ladder from the same evidence, recorded sales plus the weekly sales before them weighted by age with a ninety-day half-life: production as it prices today; a Zipf exponent fitted to all of it and shrunk toward a population exponent that is a line in the card's log value; free monotone steps per condition with the same shrinkage, which tests the Zipf form itself; and the Zipf fit with the cheapest asks as extra evidence, which tests whether sellers' ladders help. Zipf stays unless the free steps beat it out of sample, and asks are adopted only if they improve the thin conditions. It reads `DATABASE_URL` or exports passed with `--input`. An earlier hold-out on weekly market prices found a joint time-and-condition Zipf model worse than the sibling ratio; it scored against the market price and settles nothing.

## Inventory strategy page

The page exists to judge the active pricing policy and the forecasts behind it, in this order:

- A verdict header names the active policy and its parameter, its modeled physical value against the listed value, its median and P90 wait, the hurdle on the sweep whose portfolio compounds fastest under the capital-cycle inputs and what switching would change, and modeled coverage with curve freshness. A chip reports the best graded forecast's realized sold share against its expected share and Brier score, or the date the first forecast becomes gradable.
- Forecast grading follows directly, one summary line per forecast and a decile table once a cohort exists.
- The policy comparison lists the current listed prices, the active policy, and the benchmarks. The target-horizon row appears only while that policy is active; the value-matched calibration is gone.
- The hurdle sweep evaluates the profit-per-day policy at a ladder of daily return hurdles per product line, the configured hurdle shaded, since the hurdle is the only parameter the active policy has.
- The horizon curve draws the selected product line's fitted log-logistic curve as value and cycle profit per day against horizon, with the knee, best cycle, and active horizon marked, a crosshair tooltip, and a table twin on demand, above a compact per-line table of fit, floor and ceiling, knee, and best cycle.
- The percentile explorer holds the scenario builder and the full matrix for the percentile policy, collapsed and unmounted until opened.

The dashboard and the grading are served from a versioned cache that returns the last build at once when only the inventory or its curves moved and rebuilds in the background; a changed pricing configuration waits for its build. The pricing worker warms both after every batch that recorded curves.

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
