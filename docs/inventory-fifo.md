# Inventory FIFO allocation

Migration 039 adds a forward-only FIFO ledger for the seller order history and applied opening balance. Orders before the opening cutoff and ordinary receipts published before it remain historical evidence but are excluded from supply and demand. Opening units become available at the cutoff. Received units become available only when the receipt publication is confirmed live for the same seller. Equal-time sales are ordered by external order number and then stable internal identity.

The seller-order-history worker drains the local FIFO replay queue independently of provider sync success. Order revisions, applied opening balances, confirmed publication receipts, and stock dispositions enqueue the affected seller/SKU in the same database transaction. A replay writes immutable line revisions and allocation segments; `current_revision_id` is the version token for shipping summaries. Reads and shipping reloads do not allocate inventory.

`POST /api/inventory-fifo` supports `find_order`, `list_revisions`, `list_holds`, `record_disposition`, `supersede_disposition`, `record_quantity_correction`, and a bounded operator `replay`. Every action is bound to the configured seller. `find_order` returns current receipt/supply allocation segments plus source revision and pending replay state; `list_revisions` pages immutable prior snapshots. Only canonical positive integer TCGplayer SKU IDs are allocatable; custom, padded, decimal, exponent, and out-of-range identities remain explicit unsupported lines.

A canceled/refunded status is not return evidence. `unfulfilled_cancellation` requires a fully matched, canceled, never-shipped line. `physical_restock` requires the exact current source allocation keys, receipt IDs, quantities, and a new availability time. If a later provider revision reduces that line, FIFO holds until `supersede_disposition` proves that the reduction accounts for the return. The correction retires the returned quantity from its exact prior supply segment and retains the returned segment at its recorded availability time, including nested returns. Acknowledging an opening observation difference does not change stock or clear its FIFO hold.

An ordinary provider line decrease does not release allocated stock at the original order time. FIFO preserves the previous projection and exposes a hold. After inspecting `find_order`, an operator can call `record_quantity_correction` with the newer source revision, the exact newest active allocation segments, evidence, and an availability time at or after that revision was observed. That action retires those parent segments and creates derived supply only at the confirmed time. Quantity increases, amended order times, and later lifecycle/revision changes that contradict a disposition or correction remain held. Each new provider revision preserves its canonical order time, so an amendment cannot silently rewrite earlier inventory-observation coverage or cross the opening cutoff.

New provider revisions store the canonical detail order time. Migration 039 labels the current legacy revision's copied detail time, uses older revisions' separate summary timestamp only as qualified `summary_only` evidence, and leaves absent historical time evidence unknown. Unknown initial chronology creates a visible FIFO hold instead of assigning a guessed event time.

Opening and received lots with unknown market or intake time remain allocatable while price and date coverage stay unavailable. Known zero market values remain known. Market values retain four decimal places through quantity multiplication and round only at the saved line total.

Run the repository integration test only against an explicitly disposable database:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_fifo'
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npx tsx app/core/db/repositories/inventoryFifo.server.integration.test.ts
```
