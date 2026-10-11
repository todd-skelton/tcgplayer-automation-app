# Shipping threshold snaps

Under the profit-per-day policy, a price that lands just above a shipping
threshold is compared with one cent under it:

| Order item value | What changes at the threshold |
|---|---|
| $5 | Below it the buyer pays shipping; from it shipping is free. |
| $50 | From it orders ship tracked ground instead of first class. |
| $250 | From it orders ship with signature. |

Listed prices on TCGplayer show without shipping, so listing at $4.99 does
not look dearer than $5.20 even though the buyer pays shipping at checkout.

## How a snap is decided

1. The policy chooses its price and applies the price floor as before.
2. If that price is from a selected threshold to the top of the snap range
   (10% above by default), the snap price is one cent under the threshold.
3. Each price is valued as net proceeds less its expected shipping cost,
   discounted at the daily return hurdle over the curve's forecast sell time.
4. The snap price is listed only when it returns more and is at or above the
   price floor.

Nothing is considered when either price lacks a forecast, or when fewer than
20 units sold between half and twice the threshold in the evidence window.

The decision records the comparison as `shippingThresholdSnap`, with
outcome `snapped`, `kept`, or `floor`. Publications store the decision,
so each snap can be traced to what sold afterward.

## The shipping cost model

The model is relearned from the shipping seller's own orders over a
selectable trailing window (30 to 365 days, 90 by default), at most hourly:

1. **Tiers.** Mean buyer shipping and mean purchased postage per order in
   each band of order item value. A tier with fewer than 10 orders with
   postage keeps a default measured in October 2026, marked as a default.
2. **Baskets.** For every copy sold, the value of everything else in its
   order.

A unit's expected shipping cost at a price is the average, over baskets of
units sold near the threshold, of the change in (postage less buyer shipping
after fees) from adding it to that basket. A lone $50.50 card moves its order
into tracked ground; the same card beside $20 of other items crosses the
threshold either way, so snapping it saves nothing. The per-order platform
fee is the same at both prices and is left out.

The tier bands are fixed at $5, $50, and $250. If the shipping export's
letter or flat maximum value or the signature rule changes, these bands must
change with it.

## Tracking what snapping does

Pricing configuration shows the learned tiers, the expected cost per unit
at and under each threshold, and, for a selectable window, per threshold:

1. SKUs whose latest considered decision was snapped, kept, or held by the floor.
2. Sales at the snap price while snapped, sales in the snap range after a
   snap was kept, and all sales in the snap range for comparison.
3. For each: units, orders, median days from the decision's first
   publication to sale, units per order, share of orders with add-ons, share
   of snapped orders other items carried over the threshold anyway, most
   units in one order, share bought in bulk (three or more in one order),
   and shipping cost per order.

Bulk buying of snapped prices, a fall in add-ons, or slower sales than the
kept group are the signals to narrow the range or turn a threshold off.
The report is served by `GET /api/shipping-thresholds?days=90`.

Inventory Strategy previews price without snaps.
