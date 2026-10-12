# Sell-time forecast calibration

The pricing curve forecasts how many days a listing takes to sell at each
price. The target-horizon and profit-per-day policies choose prices from those
forecasts. The forecast calibration measures how the store's own listings
actually sold against their forecasts. It is a report on the configuration
page; pricing uses the forecasts as they are.

## What is measured

Continuous pricing republishes most SKUs every day, so a price is usually
listed for hours or a few days, not for a fixed horizon. The calibration
therefore follows time in stock:

1. Every price published in the window with a modeled forecast from the
   current pricing model version is one listed price. Its stock is the
   quantity counted for the pricing run, less copies sold between that count
   and publication.
2. The listed price is followed from publication until the SKU's next price
   was published, the stock sold out, or the order history ends.
3. Each order for the SKU in that time is one sale, however many copies it
   took, because the forecast is of buyers arriving. A forecast median of
   `m` days expects `ln 2 / m` sales per day in stock.

## Actual days per forecast day

Actual days per forecast day is sales forecast divided by sales seen, so 1.4
means listings took 40% longer to sell than forecast (they sold at 71% of the
forecast rate). Twenty pseudo-sales exactly as forecast steady thin samples.
It is a measurement only; nothing applies it to forecasts or prices.

The latest quarter of the window (28, 56, or 84 days; 56 by default) is held
out. The ratio measured over the earlier three quarters is confirmed when
it forecasts the held-out sales better than the forecasts as they are (a
higher Poisson likelihood), with at least 40 sales seen or forecast, whichever
is larger, earlier and 15 held out. The window ends where the latest complete
order history sync ends, and the report waits for a sync less than two days
old.

## Using it with the daily return hurdle

Listings taking a steady `r` actual days per forecast day is the same as a
change to the profit-per-day hurdle: discounting `e^(-hurdle x forecast days)`
equals discounting `e^(-(hurdle / r) x actual days)`. So the configured hurdle
asks `hurdle / r` per day listings actually take, and the report shows that
figure. To ask a given return per actual day, set the hurdle to that return
times `r`.

## Why pricing does not apply it

Applying a learned multiplier, overall or per product line, was tried and
retired. Per-product-line multipliers fit the gap but did not explain it:
the slow lines were the ones where the store lists cheap cards in thin sets,
and cheap cards mostly sell as add-ons to larger orders from the same set.
One overall ratio is better expressed as the hurdle, which the operator sets
directly. A cause found later, such as how deeply the store stocks a set,
belongs in the curve's forecast rather than a multiplier on it.

## Limits

- Only prices that were listed are measured. The ratio says how far off
  the forecasts were at the prices chosen, not how sales would change at
  prices never tried.
- Stock is the count taken for the pricing run. Copies received between
  pricing runs are not added until the next price is published.

Saved evaluations from an earlier evaluator remain in `forecast_evaluations`
and `forecast_correction_events` but are no longer read.
