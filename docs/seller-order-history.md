# Seller order history

The seller order ledger preserves order and SKU identity after an order leaves the shipping queue. The current order row is seller scoped by `(seller_key, order_number)`. Lines are keyed by SKU within that order and duplicate provider rows for the same SKU are summed. TCGPlayer does not provide a stable line ID in the verified detail response, so the original sanitized rows remain on each immutable revision as evidence while downstream inventory uses the stable aggregate.

`detail.createdAt` is the canonical order time. `search.orderDate` is retained separately because live verification found a 440 ms difference on the same order. All marketplace amounts are recorded as USD. Refund observations remain financial evidence only: the verified response has no restock flag or refunded quantity, so a refund never releases physical inventory by itself.

## Verified API coverage

Read-only verification on 2026-09-07 established this contract:

- `POST /orders/search?api-version=2.0` accepts the existing `LastThreeMonths` value, seller key, ascending order-date sort, and offset/size pagination. A scan without status filters returned Ready to Ship, Processing, Canceled, Shipped - In Transit, Shipped - Delivered, and Completed - Paid orders.
- Adjacent pages were distinct, but the reported total changed while probing as new orders arrived. A completed run therefore means every page and required detail in that observed scan was read. It is not an atomic marketplace snapshot.
- The observed oldest row was approximately three calendar months old. `AllTime` and `LastYear` were rejected, but other undocumented range labels were not tested. The ledger does not claim coverage before the observed window.
- Seller scoping is enforced by the searched seller key; an invalid key returned HTTP 403.
- Detail products contain name, unit and extended price, quantity, product ID and SKU ID. They do not contain a line ID. Statuses are strings rather than a provider enum.
- Full and partial refund samples contained time, type, amount, origin, shipping amount, and product amount/product ID/SKU ID. They contained no stable refund ID, refund quantity, or restock evidence.
- Only the observed TcgMarketplace channel and Normal fulfillment path were verified. Other channels, fulfillment paths, older endpoints, and lifecycle transitions outside the moving search window remain unverified.

The committed fixtures are synthetic and contain no buyer, address, tracking, message, or provider account data. Persistence uses the same allowlist and excludes free-text refund notes.

## Synchronization and recovery

Each worker cycle reads at most one page and 25 details, with five detail requests at once and a ten-second deadline per request. Requests disable transport retry so a cycle cannot expand its request budget. The run saves its offset, unique order identities, observed bounds, failed detail order numbers, and current total. A later cycle retries detail gaps before advancing. Empty or repeated pages, failed details, deadline failures, and budget stops leave explicit incomplete coverage; missing orders never imply cancellation or deletion.

Only one leased worker may advance a seller's run. Checkpoints and completion are fenced by its claim token. A stopped worker's claim expires after two minutes and the next cycle resumes its saved checkpoint. A new run starts after completion and overlaps the whole currently supported moving window, allowing late orders and changed lifecycle/refund/line observations to create new revisions. Orders that age out of that window retain their last observation, but later changes to them are a declared coverage gap unless supplied by file import.

Production, container development, and host development startup launch the independent worker after migrations. `npm run start:seller-order-history-worker` remains available when processes are supervised separately. The worker reads the saved default seller key. Shipping can view coverage, request one bounded catch-up, or import a file. History errors appear separately and do not prevent Ready to Ship orders from loading.

## File import fallback

The shipping page accepts CSV with these required headings:

`Order Number,Order Time,Status,SKU ID,Quantity,Gross Item Proceeds USD`

Optional headings are `Currency`, `Summary Order Time`, `Order Channel`, `Order Fulfillment`, `Product ID`, `Product Name`, `Refund Status`, `Refund Type`, `Refund Created At`, `Refund Amount USD`, and `Refund Origin`. Timestamp values must include `Z` or a numeric UTC offset. Currency must be USD. Multiple rows may represent one order, and repeated SKU rows are aggregated.

Imports fill orders unavailable from the API. They never overwrite an existing API observation because a newly loaded file may describe an older state. API/import overlap and repeated files are deduplicated while import provenance is retained.

## Isolated integration test

Create a disposable database whose name starts with `tcgplayer_fifo_test_`, then set both variables before migrating or running the integration test:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_order_history"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run db:migrate
npx tsx app/core/db/repositories/sellerOrderHistory.server.integration.test.ts
```

The test refuses to create a pool or write when `TEST_DATABASE_URL` is absent, differs from `DATABASE_URL`, or targets a database outside that naming convention.
