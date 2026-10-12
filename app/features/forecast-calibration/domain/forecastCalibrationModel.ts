const DAY_MS = 86_400_000;

/** Trailing days of listings and orders a calibration can be learned from. */
export const FORECAST_CALIBRATION_WINDOW_DAYS = [28, 56, 84] as const;
export const DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS = 56;

export const FORECAST_CALIBRATION_POLICY = {
  /** The latest share of the window is held out to check the multiplier learned before it. */
  heldOutShare: 0.25,
  /** Pseudo-sales exactly as forecast that steady a thin sample. */
  priorSales: 20,
  /** Sales seen or forecast, whichever is larger, each part of the window needs. */
  minimumSales: { earlier: 40, heldOut: 15 },
} as const;

/** A price published with a modeled sell-time forecast. */
export interface ListedPrice {
  sku: number;
  listedAt: Date;
  /** When the SKU's next price was published; null while this one is still listed. */
  replacedAt: Date | null;
  /** Copies in stock when inventory was counted for the pricing run. */
  quantity: number;
  /** When that count was taken; copies sold after it but before listing were already gone. */
  countedAt: Date;
  /** The curve's median days to sell at this price. */
  forecastMedianSellDays: number;
}

/** Copies of one SKU sold in one order. */
export interface SkuSale {
  sku: number;
  soldAt: Date;
  quantity: number;
}

/** Time listings spent in stock, the sales seen, and the sales the forecasts expected over that time. */
export interface TimeInStock {
  listings: number;
  inStockDays: number;
  sales: number;
  forecastSales: number;
}

/**
 * Whether the multiplier learned before the held-out part forecast the
 * held-out sales better than the forecasts as they are.
 */
export type HeldOutCheck = "confirmed" | "not_confirmed" | "too_few_sales";

/** How the store's listings sold against their sell-time forecasts over a window. */
export interface ForecastCalibrationReport {
  sellerKey: string;
  learnedAt: string;
  evidenceWindowDays: number;
  from: string;
  heldOutFrom: string;
  through: string;
  earlier: TimeInStock;
  heldOut: TimeInStock;
  /** Learned from the earlier part only, and checked against the held-out part. */
  earlierMultiplier: number;
  heldOutCheck: HeldOutCheck;
  /**
   * Days listings took to sell per forecast day, learned from the whole
   * window: above 1 they sold slower than forecast.
   */
  sellTimeMultiplier: number;
}

const EMPTY_TIME: TimeInStock = { listings: 0, inStockDays: 0, sales: 0, forecastSales: 0 };

const addTime = (left: TimeInStock, right: TimeInStock): TimeInStock => ({
  listings: left.listings + right.listings,
  inStockDays: left.inStockDays + right.inStockDays,
  sales: left.sales + right.sales,
  forecastSales: left.forecastSales + right.forecastSales,
});

const totalTime = (prices: readonly TimeInStock[]): TimeInStock => prices.reduce(addTime, EMPTY_TIME);

const roundMultiplier = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * One price's time in stock, from listing until it was replaced, sold out, or
 * the evidence ends, given the SKU's sales in time order. Each order is one
 * buyer arriving, whatever it bought, and the forecast expects ln 2 / median
 * days of them per day in stock.
 */
export function measureListedPrice(
  price: ListedPrice,
  skuSales: readonly SkuSale[],
  through: Date,
): TimeInStock {
  const countedAt = price.countedAt.getTime();
  const start = price.listedAt.getTime();
  const end = Math.max(start, Math.min(price.replacedAt?.getTime() ?? Infinity, through.getTime()));
  const soldBeforeListing = skuSales
    .filter((sale) => sale.soldAt.getTime() >= countedAt && sale.soldAt.getTime() < start)
    .reduce((units, sale) => units + sale.quantity, 0);
  let inStock = price.quantity - soldBeforeListing;
  let inStockUntil = inStock > 0 ? end : start;
  let sales = 0;
  for (const sale of skuSales) {
    const soldAt = sale.soldAt.getTime();
    if (inStock <= 0 || soldAt >= end) break;
    if (soldAt < start) continue;
    sales += 1;
    inStock -= sale.quantity;
    if (inStock <= 0) inStockUntil = soldAt;
  }
  const inStockDays = (inStockUntil - start) / DAY_MS;
  return {
    listings: 1,
    inStockDays,
    sales,
    forecastSales: (inStockDays * Math.LN2) / price.forecastMedianSellDays,
  };
}

/**
 * Days to sell per forecast day that best explain the sales seen, with
 * pseudo-sales exactly as forecast steadying thin samples.
 */
export function sellTimeMultiplier(time: TimeInStock): number {
  const { priorSales } = FORECAST_CALIBRATION_POLICY;
  return (time.forecastSales + priorSales) / (time.sales + priorSales);
}

/** How likely the sales seen are under a multiplier, up to a constant; higher fits better. */
export function salesLikelihood(time: TimeInStock, multiplier: number): number {
  return -time.sales * Math.log(multiplier) - time.forecastSales / multiplier;
}

/**
 * The daily return a hurdle applied over forecast days earns over the days
 * listings actually take. Discounting e^(-hurdle x forecast days) equals
 * e^(-(hurdle / multiplier) x actual days).
 */
export function actualDaysHurdle(forecastDaysHurdle: number, multiplier: number): number {
  return forecastDaysHurdle / multiplier;
}

/** Sales seen or forecast, whichever is larger: either is enough to show a forecast is off. */
const evidenceSales = (time: TimeInStock): number => Math.max(time.sales, time.forecastSales);

function salesBySku(sales: readonly SkuSale[]): Map<number, SkuSale[]> {
  const bySku = new Map<number, SkuSale[]>();
  for (const sale of sales) {
    const skuSales = bySku.get(sale.sku);
    if (skuSales) skuSales.push(sale);
    else bySku.set(sale.sku, [sale]);
  }
  for (const skuSales of bySku.values()) skuSales.sort((left, right) => left.soldAt.getTime() - right.soldAt.getTime());
  return bySku;
}

/**
 * Measures how much longer or shorter the store's listings took to sell than
 * the curve forecast. The multiplier learned before the held-out part is
 * confirmed only when it forecasts the held-out sales better than the
 * forecasts as they are.
 */
export function learnForecastCalibration(input: {
  sellerKey: string;
  prices: readonly ListedPrice[];
  sales: readonly SkuSale[];
  from: Date;
  through: Date;
  learnedAt: Date;
  evidenceWindowDays: number;
}): ForecastCalibrationReport {
  const heldOutFrom = new Date(
    input.through.getTime() -
      (input.through.getTime() - input.from.getTime()) * FORECAST_CALIBRATION_POLICY.heldOutShare,
  );
  const sales = salesBySku(input.sales);
  const measured = input.prices
    .filter(
      (price) =>
        price.quantity > 0 &&
        price.forecastMedianSellDays > 0 &&
        price.listedAt >= input.from &&
        price.listedAt < input.through,
    )
    .map((price) => ({
      heldOut: price.listedAt >= heldOutFrom,
      time: measureListedPrice(price, sales.get(price.sku) ?? [], input.through),
    }));
  const earlier = totalTime(measured.filter((price) => !price.heldOut).map((price) => price.time));
  const heldOut = totalTime(measured.filter((price) => price.heldOut).map((price) => price.time));
  const earlierMultiplier = sellTimeMultiplier(earlier);
  const { minimumSales } = FORECAST_CALIBRATION_POLICY;
  const heldOutCheck: HeldOutCheck =
    evidenceSales(earlier) < minimumSales.earlier || evidenceSales(heldOut) < minimumSales.heldOut
      ? "too_few_sales"
      : salesLikelihood(heldOut, earlierMultiplier) > salesLikelihood(heldOut, 1)
        ? "confirmed"
        : "not_confirmed";
  return {
    sellerKey: input.sellerKey,
    learnedAt: input.learnedAt.toISOString(),
    evidenceWindowDays: input.evidenceWindowDays,
    from: input.from.toISOString(),
    heldOutFrom: heldOutFrom.toISOString(),
    through: input.through.toISOString(),
    earlier,
    heldOut,
    earlierMultiplier: roundMultiplier(earlierMultiplier),
    heldOutCheck,
    sellTimeMultiplier: roundMultiplier(sellTimeMultiplier(addTime(earlier, heldOut))),
  };
}
