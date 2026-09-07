# Inventory receipt history

Inventory Manager keeps `pending_inventory` as its small aggregate queue and
records every durable change beside it:

- A received positive quantity creates one `inventory_receipts` quantity lot.
  Its SKU, original quantity, intake time, recorded time, and market evidence
  cannot be rewritten. A separate later addition creates another lot.
- A decrease or clear appends `inventory_receipt_adjustments`; it never changes
  the receipt's original quantity. Corrections consume the newest pending lots
  first so older intake evidence is not needlessly shortened.
- A batch appends `inventory_receipt_batch_links` for each contributing lot.
  Links intentionally survive pricing batch deletion and keep those units out
  of the pending queue.
- Every UI mutation and pending-to-batch conversion has a durable request ID.
  Repeating an identical request is safe. Reusing an ID with different inputs,
  or retrying a conversion after its batch was deleted, is rejected.

Market value is the unit market quote observed for that intake event. The
upstream `calculatedAt` and local observation time are separate. Missing and
failed quotes remain `NULL` with provenance; they do not block receipt capture.
Legacy pending rows migrate as quantity evidence with `intake_at` and market
fields unknown. Their old aggregate timestamps remain only in `source_evidence`.

Receipts start with nullable `seller_key`. The publication slice must bind each
batch's receipts to one seller before activation and query later FIFO holdings
by both seller and exact SKU. Once set, receipt seller ownership cannot change.

## Publication activation and recovery

Positive Inventory Manager deltas plan exact links from a publication item to
every contributing receipt lot. Planning requires one target seller and rejects
incomplete quantity or seller evidence before Seller Portal work. Only a
confirmed staged move-to-live result sets `live_at`; price-only changes,
current-holdings imports, warnings, failures, and unknown outcomes do not make
receipt stock eligible.

The app validates the configured seller consistently across the plan, receipts,
and saved result. Seller Portal uses shared credentials and does not separately
return authenticated account identity, so this proves target consistency rather
than the identity of the remote session.

If a worker lease expires after remote state may have changed, the publication
and remaining items become ambiguous and are never sent remotely again. After
an operator verifies Seller Portal evidence, local history can be repaired by
sending `PATCH` to `/api/inventory-batches/{batchNumber}/publications`:

```json
{
  "operation": "confirm-ambiguous-item",
  "publicationId": 123,
  "itemId": 456,
  "confirmedQuantity": 2,
  "sellerKey": "target-seller",
  "confirmedAt": "2026-08-10T12:00:00.000Z",
  "evidence": { "source": "operator-confirmation", "ticket": "T-123" }
}
```

The batch, seller, quantity, receipt chronology, and evidence must match. An
exact retry is idempotent; conflicting time or evidence is rejected.

Run the publication receipt integration test only against a disposable database
whose name starts with `tcgplayer_fifo_test_`:

```powershell
$testDatabaseUrl='postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_publication'
$env:TEST_DATABASE_URL=$testDatabaseUrl
$env:DATABASE_URL=$testDatabaseUrl
npm run db:migrate
npx tsx app/core/db/repositories/inventoryPublicationReceipts.server.integration.test.ts
```

Set `DATABASE_URL` to the same disposable URL while applying migrations. The
test refuses to run without the guarded `TEST_DATABASE_URL` because batch
creation intentionally consumes the database's complete pending queue.
