import type {
  ConditionRateForecast,
  ConditionSaleRate,
} from "../../../core/types/pricing";
import { medianSellDays } from "../domain/pricingPolicy";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 364;
const QUARTER_DAYS = 91;
/** A window shorter than a week says nothing about a rate. */
const MINIMUM_WINDOW_DAYS = 7;
const BUCKET_DAYS = 7;
export const CONDITION_RATE_METHOD = "annual-buckets-v1";

/** One bucket of the SKU's own sales history, as the price history API reports it. */
export interface SalesBucket {
  bucketStartDate: string;
  transactionCount: string | number;
}

/**
 * The buyer arrival interval for the listed condition alone, from a year of
 * the SKU's own weekly sales counts. The rate is the mean of the yearly and
 * quarterly rates, so the latest quarter counts twice. Held out against the
 * following month, that blend ranked slow SKUs best; the pooled all-condition
 * rate the curve uses barely beat chance.
 */
export function estimateConditionSaleRate(
  buckets: readonly SalesBucket[],
  options: { asOfTimestamp?: number; availableSinceTimestamp?: number } = {},
): ConditionSaleRate | undefined {
  const asOf = options.asOfTimestamp ?? Date.now();
  const availableSince = options.availableSinceTimestamp ?? -Infinity;
  const starts = buckets.map((bucket) =>
    new Date(bucket.bucketStartDate).getTime(),
  );
  const bucketMs =
    starts.length > 1 ? Math.abs(starts[0] - starts[1]) : BUCKET_DAYS * DAY_MS;
  // A window counts every bucket overlapping it, so a bucket straddling the
  // window's start keeps its sales; the days are the window's own.
  const window = (days: number) => {
    const start = Math.max(asOf - days * DAY_MS, availableSince);
    const transactions = buckets.reduce((total, bucket, index) => {
      const startedAt = starts[index];
      return startedAt + bucketMs > start && startedAt <= asOf
        ? total + (Number(bucket.transactionCount) || 0)
        : total;
    }, 0);
    return { transactions, days: (asOf - start) / DAY_MS };
  };
  const year = window(YEAR_DAYS);
  const quarter = window(QUARTER_DAYS);
  if (year.transactions === 0 || quarter.days < MINIMUM_WINDOW_DAYS) {
    return undefined;
  }
  const rate =
    (year.transactions / year.days + quarter.transactions / quarter.days) / 2;
  return {
    intervalDays: 1 / rate,
    transactions: year.transactions,
    method: CONDITION_RATE_METHOD,
  };
}

/** Median wait at a price where the store wins the given share of buyers. */
export function forecastConditionRate(
  rate: ConditionSaleRate | undefined,
  storeWinShare: number | undefined,
): ConditionRateForecast | undefined {
  const days = rate && medianSellDays(rate.intervalDays, storeWinShare);
  return rate && days !== undefined
    ? {
        intervalDays: rate.intervalDays,
        transactions: rate.transactions,
        method: rate.method,
        medianSellDays: days,
      }
    : undefined;
}
