import { inventoryStrategyRepository } from "~/core/db";
import { BUYER_CHOICE_CALIBRATION } from "~/features/pricing/algorithms/buyerChoiceSellTime";
import { CONDITION_RATE_METHOD } from "~/features/pricing/algorithms/conditionSaleRate";
import {
  buildCohort,
  gradeForecast,
  type ForecastGrade,
  type ForecastRecord,
} from "~/features/pricing/domain/forecastGrading";
import {
  FORECAST_GRADING_HORIZON_DAYS,
  type ForecastGradingRecord,
  type ForecastGradingReport,
} from "../types/inventoryStrategy";
import { createVersionedCache } from "./versionedCache";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NO_GRADE: ForecastGrade = {
  count: 0,
  soldShare: 0,
  brier: 0,
  deciles: [],
};

export interface ForecastGradingSource {
  /** Changes whenever the inventory or its curves change, as every priced batch does. */
  findSnapshotVersion(sellerKey: string): Promise<string>;
  findForecastGradingRecords(
    sellerKey: string,
    since: Date,
  ): Promise<ForecastGradingRecord[]>;
  findInStockSkus(sellerKey: string): Promise<number[]>;
}

const reports =
  createVersionedCache<ForecastGradingReport[]>("Forecast grading");

/**
 * The seller's forecast grading, regraded after each priced batch and at
 * least hourly as the cohort windows move, serving the last report while the
 * next one builds.
 */
export async function loadForecastGrading(
  sellerKey: string,
  source: ForecastGradingSource = inventoryStrategyRepository,
  now: Date = new Date(),
): Promise<ForecastGradingReport[]> {
  if (!sellerKey) return gradeForecasts(sellerKey, source, now);
  return reports.read(
    sellerKey,
    "",
    [
      await source.findSnapshotVersion(sellerKey),
      Math.floor(now.getTime() / HOUR_MS),
    ].join("|"),
    () => gradeForecasts(sellerKey, source, now),
  );
}

/**
 * Grades the curve, buyer-choice, and condition-rate forecasts at each
 * horizon, each over its own newest complete cohort: SKUs priced under
 * continuous pricing within the last two horizons whose first result carrying
 * that forecast is at least one horizon old. Results priced under the target-horizon policy carry no curve
 * forecast, because that policy pins it to the horizon.
 */
async function gradeForecasts(
  sellerKey: string,
  source: ForecastGradingSource,
  now: Date,
): Promise<ForecastGradingReport[]> {
  const since = new Date(
    now.getTime() - 2 * Math.max(...FORECAST_GRADING_HORIZON_DAYS) * DAY_MS,
  );
  const [rows, inStock] = sellerKey
    ? await Promise.all([
        source.findForecastGradingRecords(sellerKey, since),
        source.findInStockSkus(sellerKey),
      ])
    : [[], []];
  let otherCalibrationCount = 0;
  const records: ForecastRecord[] = [];
  for (const row of rows) {
    if (row.quantity === null) continue;
    const forecasts: Record<string, number> = {};
    const curveDays = row.curveMedianSellDays ?? 0;
    if (
      row.basis === "modeled" &&
      row.method !== "target-horizon" &&
      curveDays > 0
    ) {
      forecasts.curve = curveDays;
    }
    const buyerChoiceDays = row.buyerChoiceMedianSellDays ?? 0;
    if (row.buyerChoiceCalibration === BUYER_CHOICE_CALIBRATION.name) {
      if (buyerChoiceDays > 0) forecasts["buyer-choice"] = buyerChoiceDays;
    } else if (row.buyerChoiceCalibration !== null) {
      otherCalibrationCount += 1;
    }
    const conditionRateDays = row.conditionRateMedianSellDays ?? 0;
    if (
      row.conditionRateMethod === CONDITION_RATE_METHOD &&
      conditionRateDays > 0
    ) {
      forecasts["condition-rate"] = conditionRateDays;
    }
    records.push({
      sku: row.sku,
      pricedAt: row.pricedAt.getTime(),
      quantity: row.quantity,
      forecasts,
    });
  }
  const inStockSkus = new Set(inStock);
  return FORECAST_GRADING_HORIZON_DAYS.map((horizonDays) => {
    const windowStart = now.getTime() - 2 * horizonDays * DAY_MS;
    const windowRecords = records.filter(
      (record) => record.pricedAt >= windowStart,
    );
    const grade = (name: string) => {
      const cohort = buildCohort(
        windowRecords,
        [name],
        inStockSkus,
        horizonDays,
      );
      return cohort.length === 0
        ? NO_GRADE
        : gradeForecast(cohort, name, horizonDays);
    };
    return {
      horizonDays,
      otherCalibrationCount,
      curve: grade("curve"),
      buyerChoice: grade("buyer-choice"),
      conditionRate: grade("condition-rate"),
    };
  });
}
