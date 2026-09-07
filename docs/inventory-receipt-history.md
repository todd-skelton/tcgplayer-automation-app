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
