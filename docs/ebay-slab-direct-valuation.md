# Direct slab valuation

`estimateSlabMarket` is a pure function of accepted event prices, an explicit calculation time, evidence quality and a small policy. `proposeSlabAsk` separately applies seller shipping and cost/fee constraints. Neither function performs I/O. The server composition reads only cached immutable evidence and reviewed comp decisions; it never calls a provider during calculation.

The default baseline needs three comps and a recency-weighted count of at least 2.5. Each event receives weight `2^(-ageDays / 90)` and sales older than 365 days are excluded. The effective count is the sum of these weights, so equally old sales do not regain full strength merely because their relative weights are equal. These are initial policy choices, not calibrated predictive guarantees; later evaluation in #29 determines where borrowing grade relationships is justified.

With enough evidence, the market range is the weighted 25th/50th/75th percentile: a **descriptive middle-half range**, never a statistical confidence interval. The full observed price span, event count, weights, excluded IDs, source references and coverage flags remain available. A very wide observed span triggers review without silently deleting premium sales. Grouped means count once and trigger review. Source caps and partial coverage are explicit; stale evidence and unresolved source disagreements require review. Missing or sparse evidence returns no estimated range or proposed ask.

The default price basis is item plus reported shipping. It never mixes item-only observations with delivered observations in the same estimate. If that basis is unknown, the comp is left for review; an explicit item-only policy can instead use known item amounts. Reviewed source exclusions remove only that source reference, permitting an independently verified counterpart to remain usable. The first reference in each accepted `DirectComp` supplies the price; remaining references preserve corroborating provenance.

## Seller constraints and overrides

For an item-plus-shipping estimate, subtract the seller's known shipping charge to produce an item ask. Unknown seller shipping prevents that conversion. The seller may supply an explicit minimum item ask, or acquisition cost, shipping cost, shipping charge, minimum profit and fee assumptions. Fee inputs contain a rate, a fixed amount and whether the rate applies to item price alone or item plus shipping. No eBay fee percentage is hardcoded. Unknown inputs do not become zero and do not imply guaranteed profit.

When enough cost/fee inputs exist, the profit floor is solved algebraically under those assumptions. The final proposed ask rounds upward to the policy increment so rounding does not undercut the floor. Constraint effects remain separate from the estimated market range. A change larger than 25% from the current item ask requires review by default. Proceeds and profit are estimates under supplied assumptions; missing costs or fees yield null estimates. An unverifiable requested profit floor prevents a proposed ask.

A user price override is a separate reviewed decision with an amount, currency and reason. It does not rewrite the market range or the model's original ask/proceeds calculation. The original recommendation and override are returned separately. Publication remains #31 and must validate the current listing and applicable constraints before any write.

## Persistence and API

Migration `029_add_slab_recommendations.sql` adds immutable calculation records, evidence references and separate price overrides. Each calculation saves its model/policy versions, calculation time, confirmed identity revision, policy, seller assumptions, accepted event IDs and weights, rejected/uncertain dispositions, exact comp-review decisions and evidence retrieval metadata. Source evidence is retained in the same transaction. Equivalent normalized input at the same as-of time reuses the existing calculation.

GET `/api/slab-recommendations?id=...` returns a recommendation and a `current` flag. Identity corrections, changed comp reviews, expired evidence or replacement evidence revisions invalidate the prior calculation. Historical records and sources remain inspectable. POST accepts `intent: calculate` with the current slab ID/revision, up to twenty evidence revision IDs, pricing policy and seller context; or `intent: override` with recommendation ID, item price, currency and a review reason. Same-origin JSON bodies are limited to 16 KiB. Calculations preflight source storage size before reading at most 5 MiB/2,000 observations; persisted calculation JSON is limited to 512 KiB.

## Validation

Tests cover no/one comp, recency, stale/capped/partial history, grouped means, extreme legitimate sales, unknown shipping and currencies, seller floors, fee-rate boundaries, rounding and source-specific exclusions. Isolated PostgreSQL integration replaces global `fetch` with a throwing function to prove cached calculations do not perform network I/O. It checks idempotence, separate overrides, review/identity/evidence invalidation and retained sources.

The captured Slaking PSA 9 sample had two delivered candidate amounts, $16 and $20.72, against a $100 item ask. Buneary Master Ball PSA 10 had two, $104.99 and $116.98, against a $215 ask. Even assuming their identity review succeeds, both tests return no market range/proposed ask and flag the current ask above the sparse observed sales. The system does not blindly replace either listing with its two-point median.

Run `npm test`, `npm run typecheck`, `npm run build`, and `node node_modules/tsx/dist/cli.mjs app/features/ebay-slab-pricing/valuation/slabRecommendations.integration.test.ts`. The integration test creates a disposable schema on localhost:5433. No production listing or price is changed.
