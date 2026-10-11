import type { ForecastCorrection } from "~/core/types/pricingPolicy";

const DAY_MS = 86_400_000;

/** How corrections are learned; every correction's version starts with it. */
export const FORECAST_CORRECTION_METHOD = "time-in-stock-v1";

export const FORECAST_CORRECTION_POLICY = {
  /** The latest share of the window is held out to check the multiplier learned before it. */
  heldOutShare: 0.25,
  /** Pseudo-sales that pull a thin sample toward the broader multiplier. */
  priorSales: 20,
  /** Sales seen or forecast, whichever is larger, each part of the window needs. */
  minimumSales: {
    overall: { fit: 40, heldOut: 15 },
    productLine: { fit: 20, heldOut: 8 },
  },
  minimumMultiplier: 0.5,
  maximumMultiplier: 3,
} as const;

/** A price published with a modeled sell-time forecast. */
export interface ListedPrice {
  sku: number;
  productLineId: number | null;
  productLine: string;
  listedAt: Date;
  /** When the SKU's next price was published; null while this one is still listed. */
  replacedAt: Date | null;
  /** Copies in stock when inventory was counted for the pricing run. */
  quantity: number;
  /** When that count was taken; copies sold after it but before listing were already gone. */
  countedAt: Date;
  /** The curve's median days to sell at this price, before any correction. */
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

export type ForecastFitStatus = "applied" | "too_few_sales" | "not_better_held_out";

/** How well a multiplier learned from the earlier part of the window forecast the held-out part. */
export interface ForecastFit {
  /** Null for all product lines together. */
  productLineId: number | null;
  productLine: string;
  fit: TimeInStock;
  heldOut: TimeInStock;
  /** Multiplier on forecast median days the earlier sales imply. */
  fitMultiplier: number;
  /** What the held-out sales are compared with: no correction, or the overall one for a product line. */
  baselineMultiplier: number;
  status: ForecastFitStatus;
  /** Learned from the whole window once the held-out check passes. */
  medianDaysMultiplier?: number;
}

export interface ForecastCorrectionReport {
  method: string;
  sellerKey: string;
  learnedAt: string;
  evidenceWindowDays: number;
  from: string;
  heldOutFrom: string;
  through: string;
  overall: ForecastFit;
  productLines: ForecastFit[];
  /** What pricing applies; null when no multiplier passed its held-out check. */
  correction: ForecastCorrection | null;
}

interface MeasuredPrice extends TimeInStock {
  productLineId: number | null;
  productLine: string;
  listedAt: number;
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

const clampMultiplier = (value: number): number =>
  Math.min(
    FORECAST_CORRECTION_POLICY.maximumMultiplier,
    Math.max(FORECAST_CORRECTION_POLICY.minimumMultiplier, value),
  );

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
 * The multiplier on forecast median days that best explains the sales seen,
 * with pseudo-sales at the prior multiplier steadying thin samples.
 */
export function learnMultiplier(time: TimeInStock, prior = 1): number {
  const { priorSales } = FORECAST_CORRECTION_POLICY;
  return clampMultiplier((time.forecastSales + priorSales * prior) / (time.sales + priorSales));
}

/** How likely the sales seen are under a multiplier, up to a constant; higher fits better. */
export function salesLikelihood(time: TimeInStock, multiplier: number): number {
  return -time.sales * Math.log(multiplier) - time.forecastSales / multiplier;
}

/** Sales seen or forecast, whichever is larger: either is enough to show a forecast is off. */
const evidenceSales = (time: TimeInStock): number => Math.max(time.sales, time.forecastSales);

function checkFit(
  group: { productLineId: number | null; productLine: string; fit: TimeInStock; heldOut: TimeInStock },
  minimums: { fit: number; heldOut: number },
  prior: { fit: number; whole: number },
): ForecastFit {
  const fitMultiplier = learnMultiplier(group.fit, prior.fit);
  const enoughSales =
    evidenceSales(group.fit) >= minimums.fit && evidenceSales(group.heldOut) >= minimums.heldOut;
  const status: ForecastFitStatus = !enoughSales
    ? "too_few_sales"
    : salesLikelihood(group.heldOut, fitMultiplier) > salesLikelihood(group.heldOut, prior.fit)
      ? "applied"
      : "not_better_held_out";
  return {
    ...group,
    fitMultiplier: roundMultiplier(fitMultiplier),
    baselineMultiplier: roundMultiplier(prior.fit),
    status,
    ...(status === "applied"
      ? { medianDaysMultiplier: roundMultiplier(learnMultiplier(addTime(group.fit, group.heldOut), prior.whole)) }
      : {}),
  };
}

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
 * Learns how much longer or shorter listings took to sell than the curve
 * forecast. A multiplier learned before the held-out period is applied only
 * when it forecasts the held-out sales better than no correction; a product
 * line gets its own only when it beats the overall one on that line.
 */
export function learnForecastCorrection(input: {
  sellerKey: string;
  prices: readonly ListedPrice[];
  sales: readonly SkuSale[];
  from: Date;
  through: Date;
  learnedAt: Date;
  evidenceWindowDays: number;
}): ForecastCorrectionReport {
  const heldOutFrom = new Date(
    input.through.getTime() -
      (input.through.getTime() - input.from.getTime()) * FORECAST_CORRECTION_POLICY.heldOutShare,
  );
  const sales = salesBySku(input.sales);
  const measured: MeasuredPrice[] = input.prices
    .filter(
      (price) =>
        price.quantity > 0 &&
        price.forecastMedianSellDays > 0 &&
        price.listedAt >= input.from &&
        price.listedAt < input.through,
    )
    .map((price) => ({
      productLineId: price.productLineId,
      productLine: price.productLine,
      listedAt: price.listedAt.getTime(),
      ...measureListedPrice(price, sales.get(price.sku) ?? [], input.through),
    }));
  const split = (prices: readonly MeasuredPrice[]) => ({
    fit: totalTime(prices.filter((price) => price.listedAt < heldOutFrom.getTime())),
    heldOut: totalTime(prices.filter((price) => price.listedAt >= heldOutFrom.getTime())),
  });

  const overall = checkFit(
    { productLineId: null, productLine: "All product lines", ...split(measured) },
    FORECAST_CORRECTION_POLICY.minimumSales.overall,
    { fit: 1, whole: 1 },
  );
  const overallPrior = overall.status === "applied"
    ? { fit: overall.fitMultiplier, whole: overall.medianDaysMultiplier! }
    : { fit: 1, whole: 1 };

  const lines = new Map<number, MeasuredPrice[]>();
  for (const price of measured) {
    if (price.productLineId === null) continue;
    const linePrices = lines.get(price.productLineId);
    if (linePrices) linePrices.push(price);
    else lines.set(price.productLineId, [price]);
  }
  const productLines = [...lines.entries()]
    .map(([productLineId, prices]) =>
      checkFit(
        { productLineId, productLine: prices[0].productLine, ...split(prices) },
        FORECAST_CORRECTION_POLICY.minimumSales.productLine,
        overallPrior,
      ),
    )
    .sort((left, right) => evidenceSales(addTime(right.fit, right.heldOut)) - evidenceSales(addTime(left.fit, left.heldOut)));

  const appliedLines = productLines.filter((line) => line.status === "applied");
  const learnedAt = input.learnedAt.toISOString();
  return {
    method: FORECAST_CORRECTION_METHOD,
    sellerKey: input.sellerKey,
    learnedAt,
    evidenceWindowDays: input.evidenceWindowDays,
    from: input.from.toISOString(),
    heldOutFrom: heldOutFrom.toISOString(),
    through: input.through.toISOString(),
    overall,
    productLines,
    correction:
      overall.status !== "applied" && appliedLines.length === 0
        ? null
        : {
            version: `${FORECAST_CORRECTION_METHOD}@${learnedAt}`,
            sellerKey: input.sellerKey,
            medianDaysMultiplier: overallPrior.whole,
            ...(appliedLines.length > 0
              ? {
                  productLineMedianDaysMultipliers: Object.fromEntries(
                    appliedLines.map((line) => [line.productLineId!, line.medianDaysMultiplier!]),
                  ),
                }
              : {}),
          },
  };
}
