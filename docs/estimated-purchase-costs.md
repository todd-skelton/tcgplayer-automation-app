# Estimated purchase costs

Inventory bought without a recorded invoice still needs a cost so FIFO margins, Inventory Economics, and Inventory Strategy can report on it. When a batch is created without an entered purchase cost, the app records an estimated cost for the configured seller using one rule:

- unit cost = 75% of the TCG market price observed at intake, minus $0.30 per unit (`ESTIMATED_PURCHASE_COST_RULE`, version `market-rate-v2`). A unit worth less than $0.40 carries a negative cost: the seller effectively paid to have it taken, and it lowers the batch total;
- the batch entry allocates explicitly per receipt lot: lot quantity times the lot's unit estimate;
- the entry's purchase date is the earliest intake date among the batch's lots.

Entries carry provenance `estimated`, source `intake`, request ID `estimated-purchase-cost:market-rate-v2:batch-N`, and purchase reference `estimated:batch-N`. Because the rule version is part of the request ID, changing the rule records a correction entry (reason `Re-estimated under rule <version>`) for every batch whose amounts change and leaves batches with unchanged amounts alone. Version `market-rate-v1` floored each unit at zero; `market-rate-v2` removed the floor.

## When estimates are recorded

- Automatically when a pending-inventory batch is created without an entered cost and a default shipping seller is configured. An entered cost is always recorded instead of the estimate.
- On demand through `POST /api/inventory-economics` with `{"action":"record_estimated_purchase_costs"}` and an optional `batchNumbers` list. This is the backfill path: it walks every batch of the seller whose received lots have no purchase cost allocation and records one estimate per batch.

Both paths are idempotent. A batch with an entered cost is never touched; a batch already estimated under the current rule is reported as `repeated`, and one estimated under an earlier rule with identical amounts as `unchanged`. A batch with a lot that has no intake market quote is reported under `marketUnavailable` and left uncosted rather than partially estimated.

## Negative costs

The ledger stores the signed estimate: per-lot allocations and the batch total may be negative, and FIFO margins and Inventory Economics show them as recorded. The Inventory Strategy capital model cannot tie up negative cash, so there each purchase's net total (never below zero) is spread over its positive-cost lots in proportion to their cost and negative lots carry no capital. A purchase with only nonnegative lots is unaffected.

## What estimates do not do

Estimated costs are labeled estimated everywhere they appear and never replace an entered cost. Inventory Strategy observed turnaround still requires at least 80% of completed dollars to carry actual cost, so estimates alone do not enable automatic turnaround selection.