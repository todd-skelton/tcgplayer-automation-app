# Estimated purchase costs

Inventory bought without a recorded invoice still needs a cost so FIFO margins, Inventory Economics, and Inventory Strategy can report on it. When a batch is created without an entered purchase cost, the app records an estimated cost for the configured seller using one rule:

- unit cost = 75% of the TCG market price observed at intake, minus $0.30 per unit (`ESTIMATED_PURCHASE_COST_RULE`, version `market-rate-v2`). A unit worth less than $0.40 carries a negative cost: the seller effectively paid to have it taken, and it lowers the batch total;
- the batch entry allocates explicitly per receipt lot: lot quantity times the lot's unit estimate;
- the entry's purchase date is the earliest intake date among the batch's lots.

## Overriding the rate for a batch

Inventory Manager's "Cost of the next batch" section, above the entry table, offers three choices: the default estimate, your own rate (a percent of market and an amount less per card), or a purchase total. A rate is entered as a percent of market from 0 to 100 (up to two decimals) and dollars less per card from $0.00 to $100.00, and is saved in `inventory_batch_estimated_cost_rates` (migration 052). Like `inventory_receipt_batch_links`, that table has no foreign key to `inventory_batches`, so deleting a pricing batch does not drop its cards back to the default rate. Every later estimate of the batch uses the rate, including the worker's estimate once a card without an intake market gets one. The entry stays labeled estimated, and its request ID adds the rate, for example `estimated-purchase-cost:market-rate-v2:batch-N:market-0.6-less-50c`; the default rate entered by hand keeps the default request ID. The rate stays selected for later batches until it is changed or the page reloads; a purchase total clears after each handoff. Only `POST /api/inventory-intake-runs` accepts a rate; the older `POST /api/inventory-batches` does not.

Background inventory batches shows each queued batch's recorded cost and how it was set. "Change rate" on an estimated batch (`POST /api/inventory-economics` with `{"action":"change_estimated_cost_rate","batchNumber":N,"marketPercent":"60","perCardDeduction":"0.50"}`) saves the new rate and re-estimates the batch in one transaction, recording a correction when its amounts change. A batch with an entered purchase total refuses a rate.

Entries carry provenance `estimated`, source `intake`, request ID `estimated-purchase-cost:market-rate-v2:batch-N`, and purchase reference `estimated:batch-N`. Because the rule version is part of the request ID, changing the rule records a correction entry (reason `Re-estimated under rule <version>`, or `... at <rate>` for a batch with its own rate) for every batch whose amounts change and leaves batches with unchanged amounts alone. A correction's request ID ends in `:corrects-<entry ID>`, so a batch can return to an earlier rate without reusing that rate's request ID. Version `market-rate-v1` floored each unit at zero; `market-rate-v2` removed the floor.

## When estimates are recorded

- Automatically when a pending-inventory batch is created without an entered cost and a default shipping seller is configured. An entered cost is always recorded instead of the estimate.
- Every cycle of the seller order history worker, for each batch that still has a lot no purchase cost owns. A card without a market quote at intake leaves its batch uncosted at creation, before pricing has recorded the card's weekly market or publication its listed price; the worker estimates the batch once either exists.
- On demand through `POST /api/inventory-economics` with `{"action":"record_estimated_purchase_costs"}` and an optional `batchNumbers` list. This is the backfill path: it walks every batch of the seller whose received lots have no purchase cost allocation and records one estimate per batch.

Every path is idempotent. A batch with an entered cost is never touched; a batch already estimated under the current rule is reported as `repeated`, and one estimated under an earlier rule with identical amounts as `unchanged`. A lot with no intake market quote takes the SKU's latest weekly market price on or before its intake (or, without an intake, before the seller's inventory was first observed), else its current market price, else the seller's listed price; a batch with a lot that has none of these is reported under `marketUnavailable` and left uncosted rather than partially estimated until one appears. Opening-balance lots are gathered into one `opening_balance` batch per seller (migration 047) so they can be estimated the same way.

## Negative costs

The ledger stores the signed estimate: per-lot allocations and the batch total may be negative, and FIFO margins and Inventory Economics show them as recorded. The Inventory Strategy capital model cannot tie up negative cash, so there each purchase's net total (never below zero) is spread over its positive-cost lots in proportion to their cost and negative lots carry no capital. A purchase with only nonnegative lots is unaffected.

## What estimates do not do

Estimated costs are labeled estimated everywhere they appear and never replace an entered cost. Strategy treats estimated cost as sufficient (see `docs/strategy-assumptions.md`); nothing requires an actual cost.
