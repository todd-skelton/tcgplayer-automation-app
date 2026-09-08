# Inventory history rollout and recovery

This runbook enables the receipt, publication, seller-order, opening-balance, FIFO, and shipping-history slices for one configured seller. It is a forward cutover. It preserves older evidence without claiming purchase dates, intake values, marketplace coverage, or stock movements that the application did not observe.

The read-only `GET /api/inventory-history-diagnostics` endpoint is bound to the default shipping seller. It reports the latest order scan, applied opening cutoff, replay queue, held and unmatched quantities, unresolved inventory observations, missing received-lot snapshots, and publication failures/retries. Counts are evidence, not inferred stock corrections. A zero is a measured zero; unavailable dates and prices have their own quantities.

## Before changing the running application

1. Record the running image ID, application version, database size, current migration number, and the existing counts for pending inventory, batches, publications, postage purchases, and shipping workflows. Existing failures are the baseline and must not be attributed to this rollout.
2. Take a PostgreSQL custom-format backup and record its SHA-256 hash. Restore it into an isolated database whose name starts with `tcgplayer_fifo_test_`; remove or replace seller credentials in the clone before starting the application.
3. Apply migrations through `039_add_inventory_fifo_allocations.sql` to the clone twice. The second pass must be a no-op. Compare preexisting table counts and fingerprints using the columns that existed before the migrations.
4. Start the production build against only the sanitized clone. Verify Inventory Manager, Pending Inventory Pricer, Shipping, and the application root. Never use live Seller Portal cookies with the clone.
5. Keep the prior application image available. Do not prepare down migrations: receipt, order, opening, allocation, and correction rows are durable evidence.

## Rollout order

Keep the same request ID when retrying one operation. A different intent needs a new request ID.

### 1. Forward receipt and publication capture

Deploy migrations and the new application before receiving more inventory. Inventory Manager additions create immutable receipt lots. A typed decrease is a correction; deliberately receiving more copies is a new addition. A failed market lookup does not block receipt capture and records the market snapshot as unavailable.

Publish received units through the normal staged-delta batch workflow. The receipt becomes FIFO supply only after a positive quantity delta is confirmed live for the configured seller. A price-only publication creates no units. If a publication is ambiguous, inspect its saved item result and use the existing confirmation repair with the original seller, quantity, timestamp, and evidence. Never repeat the remote move merely because local persistence failed.

Check diagnostics. `receivedLots.missingMarketSnapshotQuantity` and `missingIntakeDateQuantity` describe received units only; opening quantities are deliberately excluded. `publications.failed` may include pre-rollout baseline failures. Investigate changes from the recorded baseline.

### 2. Seller-order catch-up

The seller-order worker performs bounded LastThreeMonths scans and drains FIFO independently. Check coverage:

```powershell
Invoke-RestMethod 'http://localhost:3001/api/seller-order-history'
```

Request one bounded pass when needed:

```powershell
$body = @{ action = 'catch_up' } | ConvertTo-Json
Invoke-RestMethod 'http://localhost:3001/api/seller-order-history' -Method Post -ContentType 'application/json' -Body $body
```

Proceed only when the latest API coverage is `complete`, `gaps` is empty, and `completedAt` is after the inventory observation that it must protect. Complete means the observed mutable API window was scanned; it does not establish atomic or older-history coverage. Use the documented bounded CSV import when an order is outside verified API coverage. Imports contain sanitized order/SKU/time/status/amount evidence and never override newer API-owned current state.

### 3. Capture, preview, and apply the opening balance

Follow [Inventory opening balance](inventory-opening-balance.md). Capture a stable, seller-validated Live export, let order coverage finish after its cutoff, then preview. Review standard-SKU quantities, unsupported custom identities, capture limitations, and every unresolved difference. The export is sellable inventory and excludes reserved Ready to Ship units; do not subtract those orders again.

Apply the reviewed preview using its exact fingerprint. Apply performs a fresh two-export validation and requires another complete order scan after that validation. If it returns a coverage error, let the worker complete and retry the same apply request. An uncommitted retry takes new external evidence. A committed retry returns the same local result without rereading or adding stock.

The cutoff is half-open: activity before the cutoff remains historical; orders and confirmed publication receipts at or after it enter forward FIFO. Opening quantities have unknown purchase date and price. Unsupported `C-*` listing identities remain visible but unavailable to standard-SKU FIFO.

### 4. Drain FIFO and inspect holds

Read the combined operational view:

```powershell
Invoke-RestMethod 'http://localhost:3001/api/inventory-history-diagnostics'
```

Use `POST /api/inventory-fifo` with `{"action":"replay"}` to perform one configured-seller replay while investigating. The normal worker drains the queue without this manual action. Do not call replay repeatedly against a hold.

List holds in bounded pages:

```json
{"action":"list_holds","afterSku":0,"limit":100}
```

For an affected order, use `find_order`, then page `list_revisions`. A replay is ready for shipping comparison when its queue has no pending/processing row and the current line is allocated, partial, excluded, or explicitly held. `unmatchedQuantity` is a shortage; it must not be replaced with zero-cost supply.

An acknowledged opening-observation difference remains an audit acknowledgement and does not move stock or clear a FIFO hold. Reconcile the physical cause with one of the following evidenced operations:

- A never-fulfilled canceled line may use `unfulfilled_cancellation` only after the ledger proves it was canceled and never shipped.
- A physical return uses `physical_restock` with the exact saved supply keys, receipt IDs, quantities, and the time it became available again.
- A refund alone is financial evidence and never restores inventory.
- A provider quantity decrease holds its previous allocation. Use `record_quantity_correction` with the newer source revision, exact newest active allocation segments, evidence, and a confirmed availability time. It does not release a unit at the original sale time.
- If later order evidence contradicts a disposition or correction, keep the hold. Do not overwrite the original evidence; use the documented correction/supersession operation only when the newer revision proves the premise.

Late orders and order revisions enqueue the earliest affected seller/SKU suffix. Let replay finish before trusting a saved shipping comparison.

### 5. Enable shipping comparisons

Load or restore a shipping workflow and verify the compact intake summaries at load, pull sheet, packing, and postage. Check a mixed-lot order, partial price/date coverage, an opening lot, a merged shipment, and receipt detail disclosure. Intake market is the immutable receipt snapshot; current market is a separate live lookup. Days held is fixed at the sale and does not grow when the screen refreshes.

If the local history endpoint, FIFO projection, or current-market lookup fails, shipping stays available. The UI removes stale intake analytics and labels history unavailable. A current-market failure leaves intake history intact; a history failure leaves current-market-only shipping intact.

## Diagnostic gates

Treat these as separate rollout axes:

- `orderCoverage.status` must be `complete` with no gaps for the protected cutover. `observedFrom` and `observedThrough` state the observed window; they do not promise older coverage.
- `openingBalance.status` must be `applied` before forward allocation is trusted. Preserve the run, validation observation, cutoff, and unsupported counts.
- `fifo.queue.pending` and `processing` should drain. `held`, line holds, `settledUnmatchedQuantity`, and unsupported identities remain visible until evidence resolves them. Settled quantity and price/date coverage include only allocated, partial, and unmatched forward lines whose SKU has no replay row. `pendingOrProcessingQuantity`, `heldQuantity`, and `queuedLineProjections` expose saved lines made stale by queue work. `lines.excludedPreCutoff` is historical demand already separated by the opening boundary.
- `stockDifferences.observedCount` reports all captured seller-export quantity changes, with review status split into unacknowledged and acknowledged counts. Acknowledgement changes only that review status: the observation remains in these totals, changes no stock, and does not clear a FIFO discrepancy hold.
- `receivedLots.missingMarketSnapshotQuantity` and `missingIntakeDateQuantity` are independent. Known market value USD 0 remains known.
- `publications.active` should return to zero. Compare ambiguous, failed, and retried counts with the pre-rollout baseline and inspect changes.

Archive a sanitized diagnostics response and the browser/latency observations with deployment evidence. Do not archive raw Seller Portal exports, order payloads, cookies, buyer details, addresses, tracking data, or provider error objects.

## Disable and rollback

If forward capture or reconciliation is unhealthy, pause the history worker by setting `INVENTORY_HISTORY_WORKER_ENABLED=false` in the application environment and restarting the current application image. The worker process remains healthy but performs neither external order synchronization nor local FIFO replay. This flag does not disable manual seller-history, opening-balance, or FIFO actions and does not disable Inventory Manager or publication writers; operators must stop those actions separately. Current market and shipping operations remain available, and existing history reads remain available. Leave the database and its evidence tables in place.

Before an opening balance is applied, reverting the application image is safe only if no receipt, publication, order-history, or inventory-observation evidence was recorded after the rollback point and relevant inventory writes remain paused. Otherwise keep the current image and repair forward.

After an opening balance is applied, keep the current receipt-aware writers. Never run an older Inventory Manager, batch, or publication writer against the cut-over seller, and never down-migrate or delete opening receipts, order revisions, publication links, FIFO revisions, dispositions, corrections, or observations. Pause the worker, keep inventory receipt/publication writes paused, and repair forward with the current image. Shipping remains usable without history enrichment. Do not restore an old database backup over newer postage, order, inventory, or publication activity.

When resuming, deploy the current image, verify diagnostics, continue the existing order scan/checkpoint, and replay the existing FIFO queue. Reuse committed operation request IDs so recovery returns the existing result. Create new request IDs only for new evidence or intent.

After the defined rollback window, securely remove raw database dumps and sanitized clones according to the application's backup policy. Retain only the backup hash and allowlisted, sanitized verification results. The final deployment record must identify the commit and image digest, confirm the seller-order-history worker started after deployment and after one restart, and show that its latest scan timestamp advanced.

## Repository acceptance test

The cross-slice scenario refuses to load the database pool unless both URLs are identical and the database name starts with `tcgplayer_fifo_test_`. It applies a zero-stock opening boundary, receives two lots, batches and confirms them live, records one sale, replays FIFO, enriches shipping, and verifies received 3 + adjusted 0 = allocated 3 + remaining 0 with a USD 14 intake market total and 43.333333 weighted days held. It repeats durable operations and injects a current-market failure.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_rollout_61'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run db:migrate
npx tsx app/features/inventory-history/services/inventoryHistoryRollout.server.integration.test.ts
```

Run `npm test`, `npm run typecheck`, and `npm run build` as the final repository checks. Production rollout, live API coverage, browser evidence, backup/restore evidence, and deployment health must be recorded on issue #61 after they are actually observed; a merged change does not complete those checks.
