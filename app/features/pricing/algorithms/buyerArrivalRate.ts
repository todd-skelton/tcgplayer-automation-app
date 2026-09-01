const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MINIMUM_CAPPED_EXPOSURE_DAYS = 1 / 24;

export const LATEST_SALES_HISTORY_DAYS = 90;
export const LATEST_SALES_LIMIT = 100;

type BuyerArrivalObservation = {
  price: number;
  timestamp: number;
};

type BuyerArrivalEstimate = {
  intervalDays?: number;
  qualifyingSalesCount: number;
  weightedSalesCount: number;
  observationDays: number;
  effectiveExposureDays: number;
  historyCapped: boolean;
  exposureStartReason: "history-window" | "sales-cap" | "availability";
};

export function estimateBuyerArrivalAtPrice(
  sales: BuyerArrivalObservation[],
  targetPrice: number,
  options: {
    asOfTimestamp?: number;
    halfLifeDays?: number;
    availableSinceTimestamp?: number;
  } = {},
): BuyerArrivalEstimate {
  const asOfTimestamp = options.asOfTimestamp ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? Infinity;
  const validSales = sales
    .filter(
      (sale) =>
        sale.price > 0 &&
        Number.isFinite(sale.timestamp) &&
        sale.timestamp <= asOfTimestamp,
    )
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, LATEST_SALES_LIMIT);
  const historyCapped = validSales.length === LATEST_SALES_LIMIT;
  const oldestReturnedTimestamp = Math.min(
    asOfTimestamp,
    ...validSales.map((sale) => sale.timestamp),
  );
  const uncappedStart =
    asOfTimestamp - LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY;
  const observedExposureStart = historyCapped
    ? oldestReturnedTimestamp
    : uncappedStart;
  const providedAvailabilityTimestamp = Number.isFinite(
    options.availableSinceTimestamp,
  )
    ? options.availableSinceTimestamp!
    : undefined;
  const oldestObservedSaleTimestamp = validSales.at(-1)?.timestamp;
  const availableSinceTimestamp =
    providedAvailabilityTimestamp === undefined
      ? undefined
      : oldestObservedSaleTimestamp === undefined
        ? Math.min(asOfTimestamp, providedAvailabilityTimestamp)
        : Math.min(providedAvailabilityTimestamp, oldestObservedSaleTimestamp);
  const exposureStart = Math.max(
    observedExposureStart,
    availableSinceTimestamp ?? Number.NEGATIVE_INFINITY,
  );
  const exposureStartReason =
    availableSinceTimestamp !== undefined &&
    availableSinceTimestamp > observedExposureStart
      ? "availability"
      : historyCapped
        ? "sales-cap"
        : "history-window";
  const observationDays = Math.max(
    MINIMUM_CAPPED_EXPOSURE_DAYS,
    (asOfTimestamp - exposureStart) / MILLISECONDS_PER_DAY,
  );
  const decayRate =
    Number.isFinite(halfLifeDays) && halfLifeDays > 0
      ? Math.LN2 / halfLifeDays
      : 0;
  const effectiveExposureDays =
    decayRate > 0
      ? (1 - Math.exp(-decayRate * observationDays)) / decayRate
      : observationDays;
  const qualifyingSales = validSales.filter(
    (sale) => sale.timestamp >= exposureStart && sale.price >= targetPrice,
  );
  const weightedSalesCount = qualifyingSales.reduce((total, sale) => {
    const ageDays = (asOfTimestamp - sale.timestamp) / MILLISECONDS_PER_DAY;
    return total + (decayRate > 0 ? Math.exp(-decayRate * ageDays) : 1);
  }, 0);

  return {
    intervalDays:
      weightedSalesCount > 0
        ? effectiveExposureDays / weightedSalesCount
        : undefined,
    qualifyingSalesCount: qualifyingSales.length,
    weightedSalesCount,
    observationDays,
    effectiveExposureDays,
    historyCapped,
    exposureStartReason,
  };
}
