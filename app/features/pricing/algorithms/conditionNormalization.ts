import type { ConditionNormalizationDetail } from "../../../core/types/pricing";
import { INVENTORY_CONDITION_ORDER } from "../../../core/utils/conditionOrder";
import type { Sale } from "../../../integrations/tcgplayer/client/get-latest-sales.server";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import {
  LATEST_SALES_HISTORY_DAYS,
  LATEST_SALES_LIMIT,
} from "./buyerArrivalRate";
import { getEffectiveSalePrice } from "./getEffectiveSalePrice";

const CONDITION_ORDER: Condition[] = INVENTORY_CONDITION_ORDER;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MODEL_PARAMETER_COUNT = 3;
const MINIMUM_OBSERVATIONS_PER_CONDITION = 2;
const MINIMUM_RESIDUAL_DEGREES_OF_FREEDOM = 2;

export interface ConditionNormalizationOptions {
  asOfTimestamp?: number;
}

type Observation = {
  rank: number;
  price: number;
  timestamp: number;
};

function solveLinearSystem(
  matrix: number[][],
  values: number[],
): number[] | undefined {
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < augmented.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column]))
        pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return undefined;
    [augmented[column], augmented[pivot]] = [
      augmented[pivot],
      augmented[column],
    ];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= augmented.length; entry += 1)
      augmented[column][entry] /= divisor;
    for (let row = 0; row < augmented.length; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= augmented.length; entry += 1)
        augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row.at(-1) ?? 0);
}

function conditionInformation(observations: Observation[]): number {
  if (observations.length < 2) return 0;

  const times = observations.map(
    ({ timestamp }) => timestamp / MILLISECONDS_PER_DAY,
  );
  const conditions = observations.map(({ rank }) => Math.log(rank));
  const meanTime =
    times.reduce((total, value) => total + value, 0) / times.length;
  const meanCondition =
    conditions.reduce((total, value) => total + value, 0) / conditions.length;
  const timeVariance = times.reduce(
    (total, value) => total + (value - meanTime) ** 2,
    0,
  );
  const covariance = times.reduce(
    (total, value, index) =>
      total + (value - meanTime) * (conditions[index] - meanCondition),
    0,
  );
  const slope = timeVariance > 0 ? covariance / timeVariance : 0;
  return conditions.reduce((total, value, index) => {
    const expected = meanCondition + slope * (times[index] - meanTime);
    return total + (value - expected) ** 2;
  }, 0);
}

function conditionTimelinesAreConnected(observations: Observation[]): boolean {
  const ranges = new Map<number, { minimum: number; maximum: number }>();
  for (const observation of observations) {
    const range = ranges.get(observation.rank);
    ranges.set(observation.rank, {
      minimum: Math.min(
        range?.minimum ?? observation.timestamp,
        observation.timestamp,
      ),
      maximum: Math.max(
        range?.maximum ?? observation.timestamp,
        observation.timestamp,
      ),
    });
  }
  const ranks = [...ranges.keys()];
  if (ranks.length < 2) return false;

  const connected = new Set<number>([ranks[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rank of ranks) {
      if (connected.has(rank)) continue;
      const candidate = ranges.get(rank)!;
      const overlapsConnectedRange = [...connected].some((connectedRank) => {
        const existing = ranges.get(connectedRank)!;
        return (
          candidate.minimum <= existing.maximum &&
          existing.minimum <= candidate.maximum
        );
      });
      if (overlapsConnectedRange) {
        connected.add(rank);
        changed = true;
      }
    }
  }
  return connected.size === ranks.length;
}

function multipliersForExponent(
  exponent: number,
  targetCondition: Condition,
): Map<Condition, number> {
  const targetRank = CONDITION_ORDER.indexOf(targetCondition) + 1;
  return new Map(
    CONDITION_ORDER.map((condition, index) => [
      condition,
      Math.pow((index + 1) / targetRank, exponent),
    ]),
  );
}

export function fitTimeAwareZipfModelToConditions(
  sales: Sale[],
  targetCondition: Condition,
  options: ConditionNormalizationOptions = {},
): {
  multipliers: Map<Condition, number>;
  diagnostics: ConditionNormalizationDetail;
} {
  const asOfTimestamp = options.asOfTimestamp ?? Date.now();
  const oldestTimestamp =
    asOfTimestamp - LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY;
  const candidateObservations = sales
    .flatMap((sale): Observation[] => {
      const rank = CONDITION_ORDER.indexOf(sale.condition as Condition) + 1;
      const price = getEffectiveSalePrice(sale);
      const timestamp = new Date(sale.orderDate).getTime();
      return rank > 0 && price > 0 && Number.isFinite(timestamp)
        ? [{ rank, price, timestamp }]
        : [];
    })
    .filter(
      ({ timestamp }) =>
        timestamp >= oldestTimestamp && timestamp <= asOfTimestamp,
    )
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, LATEST_SALES_LIMIT);
  const observationsPerCondition = new Map<number, number>();
  for (const observation of candidateObservations) {
    observationsPerCondition.set(
      observation.rank,
      (observationsPerCondition.get(observation.rank) ?? 0) + 1,
    );
  }
  const supportedConditions = new Set(
    [...observationsPerCondition]
      .filter(([, count]) => count >= MINIMUM_OBSERVATIONS_PER_CONDITION)
      .map(([rank]) => rank),
  );
  const observations = candidateObservations.filter(({ rank }) =>
    supportedConditions.has(rank),
  );
  const conditionCount = new Set(observations.map(({ rank }) => rank)).size;
  const fallbackMultipliers = multipliersForExponent(0, targetCondition);
  const information = conditionInformation(observations);
  const conditionTimeConnected = conditionTimelinesAreConnected(observations);
  const diagnostics = {
    observationCount: observations.length,
    observedConditionCount: conditionCount,
    conditionTimeConnected,
  };

  if (
    observations.length <
      MODEL_PARAMETER_COUNT + MINIMUM_RESIDUAL_DEGREES_OF_FREEDOM ||
    conditionCount < 2 ||
    information < 1e-6 ||
    !conditionTimeConnected
  ) {
    return {
      multipliers: fallbackMultipliers,
      diagnostics: {
        ...diagnostics,
        method: "neutral-condition-fallback",
        conditionExponent: 0,
      },
    };
  }

  const features = observations.map(({ rank, timestamp }) => [
    1,
    (timestamp - asOfTimestamp) /
      (LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY),
    Math.log(rank),
  ]);
  const logPrices = observations.map(({ price }) => Math.log(price));
  let robustWeights = observations.map(() => 1);
  let coefficients: number[] | undefined;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const matrix = Array.from({ length: 3 }, () => Array(3).fill(0));
    const vector = Array(3).fill(0);
    for (let row = 0; row < features.length; row += 1) {
      for (let left = 0; left < 3; left += 1) {
        vector[left] +=
          robustWeights[row] * features[row][left] * logPrices[row];
        for (let right = 0; right < 3; right += 1)
          matrix[left][right] +=
            robustWeights[row] * features[row][left] * features[row][right];
      }
    }
    coefficients = solveLinearSystem(matrix, vector);
    if (!coefficients) break;

    const residuals = features.map(
      (row, index) =>
        logPrices[index] -
        row.reduce(
          (total, value, column) => total + value * coefficients![column],
          0,
        ),
    );
    const absoluteResiduals = residuals
      .map(Math.abs)
      .sort((left, right) => left - right);
    const scale =
      (absoluteResiduals[Math.floor(absoluteResiduals.length / 2)] || 0.01) *
      1.4826;
    robustWeights = residuals.map((residual) =>
      Math.min(1, (1.345 * scale) / Math.max(Math.abs(residual), 1e-10)),
    );
  }

  if (!coefficients) {
    return {
      multipliers: fallbackMultipliers,
      diagnostics: {
        ...diagnostics,
        method: "neutral-condition-fallback",
        conditionExponent: 0,
      },
    };
  }

  const conditionExponent = Math.max(0, Math.min(2, -coefficients[2]));
  return {
    multipliers: multipliersForExponent(conditionExponent, targetCondition),
    diagnostics: {
      ...diagnostics,
      method: "time-controlled-zipf",
      conditionExponent,
    },
  };
}

export function normalizeSalesToTargetCondition(
  sales: Sale[],
  conditionMultipliers?: Map<Condition, number>,
): { price: number; quantity: number; timestamp: number }[] {
  return sales.map((sale) => ({
    price:
      getEffectiveSalePrice(sale) *
      (conditionMultipliers?.get(sale.condition as Condition) ?? 1),
    quantity: sale.quantity || 1,
    timestamp: new Date(sale.orderDate).getTime(),
  }));
}
