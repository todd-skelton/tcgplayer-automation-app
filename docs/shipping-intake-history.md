# Shipping intake history

Shipping order loads keep today's TCG market comparison separate from the market snapshot recorded when inventory was received. Intake market is the sum of the FIFO receipt segments whose prices are known; sold value is compared only for the same covered unit count and is not labeled profit. A recorded zero-dollar snapshot remains known. Price and intake-date coverage are counted independently.

Age is frozen from each receipt's intake time to the persisted order time. The primary age is quantity weighted across date-known units, with the shortest and longest lot ages shown beside it. Receipt detail also identifies dated physical returns and quantity corrections by their later availability time.

The server attaches history only when seller, order number, exact raw SKU, aggregate SKU quantity, allocation source revision, and persisted FIFO totals agree. Repeated provider rows for a SKU share one SKU aggregate. Pending, held, mismatched, unsupported, and unidentified quantities remain visible and do not contribute stale intake totals. Combined shipments de-duplicate external order numbers.

`POST /api/shipping-export/intake-history` refreshes up to 500 saved orders using only order number, order date, item count, product value, raw SKU identity, quantity, and unit price. It sends no buyer, address, card-name, or tracking data and is bound to the seller saved in Shipping Configuration. Saved workflows refresh locally on restore, window focus, and every five minutes. A failed refresh removes the saved analytics and leaves shipping operations available.

The guarded repository integration requires an explicit disposable database:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5433/tcgplayer_fifo_test_shipping_history'
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npx tsx app/features/shipping-export/services/shippingIntakeHistory.server.integration.test.ts
```

The test refuses to load the database module unless both variables match and the database name begins with `tcgplayer_fifo_test_`.
