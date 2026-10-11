# Sell-time forecast correction

The pricing curve forecasts how many days a listing takes to sell at each
price. The target-horizon and profit-per-day policies choose prices from those
forecasts, so a forecast that is consistently too fast or too slow moves every
price. The forecast correction measures how the store's own listings actually
sold against their forecasts and stretches or shortens the curve's median
days to sell by a learned multiplier.

It is off by default and turned on from the configuration page. The policy
must be target-horizon or profit-per-day; the percentile policy ignores it.

## What is measured

Continuous pricing republishes most SKUs every day, so a price is usually
listed for hours or a few days, not for a fixed horizon. The correction
therefore follows time in stock instead of waiting for a horizon to mature:

1. Every price published in the window with a modeled forecast from the
   current pricing model version is one listed price. Its stock is the
   quantity counted for the pricing run, less copies sold between that count
   and publication.
2. The listed price is followed from publication until the SKU's next price
   was published, the stock sold out, or the order history ends.
3. Each order for the SKU in that time is one sale, however many copies it
   took, because the forecast is of buyers arriving. A forecast median of
   `m` days expects `ln 2 / m` sales per day in stock.
4. Sales seen and sales forecast are totaled overall and per product line.

## How a multiplier is learned and checked

The multiplier is forecast sales divided by sales seen, so 1.4x means listings
took 40% longer to sell than forecast. Twenty pseudo-sales at the prior
multiplier steady thin samples: no correction for the overall multiplier, and
the overall multiplier for a product line.

The latest quarter of the window is held out. A multiplier learned from the
earlier three quarters is applied only when it forecasts the held-out sales
better than its comparison (a higher Poisson likelihood): no correction for the
overall multiplier, the overall multiplier for a product line. Each part also
needs enough sales seen or forecast, whichever is larger: 40 earlier and 15
held out overall, 20 and 8 per product line. A multiplier that passes is then
relearned from the whole window and kept between 0.5x and 3x.

When nothing passes, pricing uses the forecasts as they are.

## When it applies

- Pricing relearns the correction at most hourly from the trailing window
  (28, 56, or 84 days; 56 by default), ending where the latest complete order
  history sync ends. If that sync is more than two days old, or the
  correction cannot be learned, pricing goes ahead uncorrected.
- It is learned from the continuous pricing seller's sales and applies only
  to that seller's inventory and to intake priced for the store; another
  seller's inventory is priced uncorrected.
- Each decision records `forecastCorrectionVersion` (the method and when it
  was learned) and `forecastCorrectionMultiplier` (the multiplier applied to
  that product line), so published prices can be traced to the correction.
  The recorded median is the corrected one; the correction reads it back
  divided by that multiplier, so it always learns against the uncorrected
  curve.

## Limits

- Only prices that were listed are measured. A correction says how far off
  the forecasts were at the prices chosen, not how sales would change at
  prices never tried.
- A product line whose sales differ from the overall multiplier but have too
  few sales to pass its own check uses the overall multiplier.
- Stock is the count taken for the pricing run. Copies received between
  pricing runs are not added until the next price is published.

The previous evaluator, which waited for a 21-day horizon per price and needed
complete inventory observations, never admitted a price under daily
repricing; it and its manual activation were removed. Its saved evaluations
remain in `forecast_evaluations` and `forecast_correction_events` but are
no longer read.
