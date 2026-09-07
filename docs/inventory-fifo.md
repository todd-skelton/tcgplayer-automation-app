# Inventory FIFO allocation

Migration 039 adds a forward-only FIFO ledger for the seller order history and applied opening balance. Orders before the opening cutoff and ordinary receipts published before it remain historical evidence but are excluded from supply and demand. Opening units become available at the cutoff. Received units become available only when the receipt publication is confirmed live for the same seller. Equal-time sales are ordered by external order number and then stable internal identity.

The seller-order-history worker drains the local FIFO replay queue independently of provider sync success. Order revisions, applied opening balances, confirmed publication receipts, and stock dispositions enqueue the affected seller/SKU in the same database transaction. A replay writes immutable line revisions and allocation segments; `current_revision_id` is the version token for shipping summaries. Reads and shipping reloads do not allocate inventory.

`POST /api/inventory-fifo` supports `find_order`, `list_holds`, `record_disposition`, `supersede_disposition`, and a bounded operator `replay`. Every action is bound to the configured seller. A canceled/refunded status is not return evidence. `unfulfilled_cancellation` requires a fully matched, canceled, never-shipped line. `physical_restock` requires the original receipt allocation and a new availability time. If a provider later reduces that line, FIFO holds until `supersede_disposition` records evidence that the provider revision already accounts for the return. Acknowledging an opening observation difference does not change stock.

Opening and received lots with unknown market or intake time remain allocatable while price and date coverage stay unavailable. Known zero market values remain known. Market values retain four decimal places through quantity multiplication and round only at the saved line total.

Run the repository integration test only against an explicitly disposable database:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_fifo'
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npx tsx app/core/db/repositories/inventoryFifo.server.integration.test.ts
```
