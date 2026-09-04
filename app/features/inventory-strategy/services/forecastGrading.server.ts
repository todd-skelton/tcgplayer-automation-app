import { inventoryStrategyRepository } from "~/core/db";
import { BUYER_CHOICE_CALIBRATION } from "~/features/pricing/algorithms/buyerChoiceSellTime";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_NAMES = ["curve", "buyer-choice"];
const NO_GRADE: ForecastGrade = {
  count: 0,
  soldShare: 0,
  brier: 0,
  deciles: [],
};

export interface ForecastGradingSource {
  findForecastGradingRecords(
    sellerKey: string,
    since: Date,
  ): Promise<ForecastGradingRecord[]>;
  findInStockSkus(sellerKey: string): Promise<number[]>;
}

/**
 * Grades the curve forecast and the buyer-choice forecast at each horizon
 * over the newest complete cohort: SKUs priced under continuous pricing
 * within the last two horizons whose first graded result is at least one
 * horizon old. Results priced under the target-horizon policy carry no curve
 * forecast, because that policy pins it to the horizon.
 */
export async function loadForecastGrading(
  sellerKey: string,
  source: ForecastGradingSource = inventoryStrategyRepository,
  now: Date = new Date(),
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
    const cohort = buildCohort(
      records.filter((record) => record.pricedAt >= windowStart),
      FORECAST_NAMES,
      inStockSkus,
      horizonDays,
    );
    const grade = (name: string) =>
      cohort.length === 0 ? NO_GRADE : gradeForecast(cohort, name, horizonDays);
    const curve = grade("curve");
    return {
      horizonDays,
      cohortSize: cohort.length,
      soldShare: curve.soldShare,
      baseRateBrier: curve.soldShare * (1 - curve.soldShare),
      otherCalibrationCount,
      curve,
      buyerChoice: grade("buyer-choice"),
    };
  });
}
