# Estimated purchase costs

Inventory bought without a recorded invoice still needs a cost so FIFO margins, Inventory Economics, and Inventory Strategy can report on it. When a batch is created without an entered purchase cost, the app records an estimated cost for the configured seller using one rule:

- unit cost = 75% of the TCG market price observed at intake, minus $0.30 per unit (`ESTIMATED_PURCHASE_COST_RULE`, version `market-rate-v2`). A unit worth less than $0.40 carries a negative cost: the seller effectively paid to have it taken, and it lowers the batch total;
- the batch entry allocates explicitly per receipt lot: lot quantity times the lot's unit estimate;
- the entry's purchase date is the earliest intake date among the batch's lots.

## Overriding the rate for a batch

When queuing a batch, Inventory Manager offers three cost choices: the default estimate, an estimate at your own percent of market and amount less per card, or an entered purchase total. A rate is entered as a percent of market from 0 to 100 (up to two decimals) and dollars less per card from $0.00 to $100.00, and is saved on the batch (`inventory_batches.estimated_cost_market_rate` and `estimated_cost_per_unit_deduction_cents`, migration 052). Every later estimate of that batch uses it, including the worker's estimate once a card without an intake market gets one. The entry stays labeled estimated, and its request ID adds the rate, for example `estimated-purchase-cost:market-rate-v2:batch-N:market-0.6-less-50c`. A rate equal to the default records the default estimate. The rate stays selected for the next batch until another choice is made; a purchase total clears after each handoff.

Entries carry provenance `estimated`, source `intake`, request ID `estimated-purchase-cost:market-rate-v2:batch-N`, and purchase reference `estimated:batch-N`. Because the rule version is part of the request ID, changing the rule records a correction entry (reason `Re-estimated under rule <version>`) for every batch whose amounts change and leaves batches with unchanged amounts alone. Version `market-rate-v1` floored each unit at zero; `market-rate-v2` removed the floor.

## When estimates are recorded

- Automatically when a pending-inventory batch is created without an entered cost and a default shipping seller is configured. An entered cost is always recorded instead of the estimate.
- Every cycle of the seller order history worker, for each batch that still has a lot no purchase cost owns. A card without a market quote at intake leaves its batch uncosted at creation, before pricing has recorded the card's weekly market or publication its listed price; the worker estimates the batch once either exists.
- On demand through `POST /api/inventory-economics` with `{"action":"record_estimated_purchase_costs"}` and an optional `batchNumbers` list. This is the backfill path: it walks every batch of the seller whose received lots have no purchase cost allocation and records one estimate per batch.

Every path is idempotent. A batch with an entered cost is never touched; a batch already estimated under the current rule is reported as `repeated`, and one estimated under an earlier rule with identical amounts as `unchanged`. A lot with no intake market quote takes the SKU's latest weekly market price on or before its intake (or, without an intake, before the seller's inventory was first observed), else its current market price, else the seller's listed price; a batch with a lot that has none of these is reported under `marketUnavailable` and left uncosted rather than partially estimated until one appears. Opening-balance lots are gathered into one `opening_balance` batch per seller (migration 047) so they can be estimated the same way.

## Negative costs

The ledger stores the signed estimate: per-lot allocations and the batch total may be negative, and FIFO margins and Inventory Economics show them as recorded. The Inventory Strategy capital model cannot tie up negative cash, so there each purchase's net total (never below zero) is spread over its positive-cost lots in proportion to their cost and negative lots carry no capital. A purchase with only nonnegative lots is unaffected.

## What estimates do not do

Estimated costs are labeled estimated everywhere they appear and never replace an entered cost. Strategy treats estimated cost as sufficient (see `docs/strategy-assumptions.md`); nothing requires an actual cost.
