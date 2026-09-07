# Inventory opening balance

The opening-balance workflow establishes the forward FIFO boundary for one configured seller. It does not reconstruct purchase dates or costs that the application cannot prove.

## Evidence and cutoff

`capture` reads the authenticated Seller Portal pricing context, downloads the complete **Export From Live** CSV twice, and then reads the pricing context again. Both context reads must identify the configured seller. Both exports must contain the same normalized `(SKU, Total Quantity)` set. Raw content hashes are retained as provenance, while price-only changes do not make the quantity observation unstable.

The export's `Total Quantity` is treated as sellable inventory and excludes units already reserved by orders such as Ready to Ship. Those reserved units are not subtracted again. The capture interval starts before the first identity check and ends after the final identity check. Any order or confirmed publication in that half-open interval `[startedAt, cutoffAt)` blocks the preview because its inclusion in the export is ambiguous.

Before preview, seller-order history must complete a gap-free TCGplayer API scan after the cutoff. The opening run copies the allowlisted coverage evidence because completed sync runs have bounded retention. A preview also freezes the pre-cutoff order revisions, confirmed receipt activations, and positive-SKU catalog mappings. Apply rechecks that evidence under a seller-scoped advisory lock.

## Forward-only policy

Positive export quantities become one opening receipt per SKU. These receipts have explicit FIFO precedence before ordinary receipts, but their `intake_at`, intake market value, and market observation time remain `NULL`. The system records their provenance as `opening_balance_unknown`; it never substitutes capture time or current market value for missing history.

The cutoff is half-open: activity before `cutoffAt` belongs to the historical side, while activity at or after `cutoffAt` belongs to forward processing. Downstream FIFO allocation must dynamically exclude orders and confirmed receipt activations with evidence before the applied cutoff. This also covers pre-cutoff evidence discovered after the opening run. Opening receipts never enter pending inventory, pricing batches, or publication.

This workflow deliberately does not restore canceled or refunded stock, estimate historical purchases, or infer a receipt or sale from an inventory difference. A later complete observation records per-SKU deltas against the prior observation. An operator may acknowledge that a discrepancy was reviewed, but that action does not classify it as a receipt or sale and does not change inventory. A stock correction is a separate, evidenced operation composed with forward reconciliation.

## Operator workflow

The endpoint is `POST /api/inventory-opening-balance`. The seller may be omitted and then defaults to the configured shipping seller. Keep each request ID stable when retrying the same operation.

1. Capture a stable observation:

   ```json
   {"action":"capture","requestId":"opening-observation-2026-09-07","sellerKey":"seller-a"}
   ```

2. Let the independent seller-order worker finish a complete API scan after the returned cutoff.

3. Preview without changing stock:

   ```json
   {"action":"preview","requestId":"opening-preview-2026-09-07","sellerKey":"seller-a","observationId":"123"}
   ```

   Review `skuCount`, `positiveSkuCount`, `totalQuantity`, and every `unresolved` item. A blocked preview cannot be applied. Capture a new observation after resolving an unstable capture or interval conflict. Inventory changes against an earlier observation must be reviewed explicitly:

   ```json
   {"action":"acknowledge_difference","requestId":"opening-difference-45-review","sellerKey":"seller-a","differenceId":"45","note":"Compared with the Seller Portal export; no inventory cause was inferred."}
   ```

4. Apply the exact preview:

   ```json
   {"action":"apply","sellerKey":"seller-a","runId":"67","evidenceFingerprint":"<fingerprint returned by preview>"}
   ```

Apply is idempotent for the same run and fingerprint. A changed fingerprint or seller is rejected. Only one opening balance can be applied per seller.

## Integration test

Use a disposable database whose name starts with `tcgplayer_fifo_test_`. The test refuses to load the database module until both variables point to that same database.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_opening_58'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npx tsx app/core/db/repositories/inventoryOpeningBalances.server.integration.test.ts
```

Apply all migrations through `038_add_inventory_opening_balances.sql` before running the test.
