# Estimated purchase costs

Inventory bought without a recorded invoice still needs a cost so FIFO margins, Inventory Economics, and Inventory Strategy can report on it. When a batch is created without an entered purchase cost, the app records an estimated cost for the configured seller using one rule:

- unit cost = 75% of the TCG market price observed at intake, minus $0.30 per unit, never below zero (`ESTIMATED_PURCHASE_COST_RULE`, version `market-rate-v1`);
- the batch entry allocates explicitly per receipt lot: lot quantity times the lot's unit estimate;
- the entry's purchase date is the earliest intake date among the batch's lots.

Entries carry provenance `estimated`, source `intake`, request ID `estimated-purchase-cost:market-rate-v1:batch-N`, and purchase reference `estimated:batch-N`. Because the rule version is part of the request ID, changing the rule records new entries under a new version instead of silently repeating the old ones.

## When estimates are recorded

- Automatically when a pending-inventory batch is created without an entered cost and a default shipping seller is configured. An entered cost is always recorded instead of the estimate.
- On demand through `POST /api/inventory-economics` with `{"action":"record_estimated_purchase_costs"}` and an optional `batchNumbers` list. This is the backfill path: it walks every batch of the seller whose received lots have no purchase cost allocation and records one estimate per batch.

Both paths are idempotent. A batch that already has a cost (entered or estimated) is skipped because its lots are already allocated; a repeated request ID is reported as `repeated`. A batch with a lot that has no intake market quote is reported under `marketUnavailable` and left uncosted rather than partially estimated.

## What estimates do not do

Estimated costs are labeled estimated everywhere they appear and never replace an entered cost. Inventory Strategy observed turnaround still requires at least 80% of completed dollars to carry actual cost, so estimates alone do not enable automatic turnaround selection.