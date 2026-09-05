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
/** The fitted exponent's cap of 2 spans at most 5^2 between the extreme conditions. */
const SIBLING_RATIO_LIMIT = 25;

export interface ConditionNormalizationOptions {
  asOfTimestamp?: number;
  /** Latest market price of each condition of the same product, variant, and language. */
  siblingMarketPrices?: ReadonlyMap<Condition, number>;
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

/**
 * The nearest priced condition to an unpriced one: the closest better
 * condition with a market price, else the closest worse.
 */
function nearestPricedCondition(
  marketPrices: ReadonlyMap<Condition, number>,
  condition: Condition,
): Condition | undefined {
  const priced = (candidate: Condition): boolean =>
    (marketPrices.get(candidate) ?? 0) > 0;
  const rank = CONDITION_ORDER.indexOf(condition);
  const better = CONDITION_ORDER.slice(0, rank).reverse().find(priced);
  return better ?? CONDITION_ORDER.slice(rank + 1).find(priced);
}

/**
 * One value per condition for the whole card, from the sibling SKUs' market
 * prices. A condition without a price takes its nearest priced neighbour's,
 * and no condition is valued above a better one: where the market prices
 * disagree with the condition order, the better condition's price wins,
 * since it rests on far more sales. Every condition's value is bounded to
 * the reach of the fitted exponent below Near Mint's.
 */
function conditionValueLadder(
  marketPrices: ReadonlyMap<Condition, number>,
): { values: Map<Condition, number>; anchors: Map<Condition, Condition> } | undefined {
  const values = new Map<Condition, number>();
  const anchors = new Map<Condition, Condition>();
  let ceiling = Infinity;
  for (const condition of CONDITION_ORDER) {
    const own = marketPrices.get(condition);
    let value: number | undefined = own && own > 0 ? own : undefined;
    if (value === undefined) {
      const neighbour = nearestPricedCondition(marketPrices, condition);
      if (neighbour === undefined) return undefined;
      value = marketPrices.get(neighbour)!;
      anchors.set(condition, neighbour);
    }
    value = Math.min(value, ceiling);
    values.set(condition, value);
    ceiling = value;
  }
  const best = values.get(CONDITION_ORDER[0])!;
  for (const [condition, value] of values) {
    values.set(condition, Math.max(value, best / SIBLING_RATIO_LIMIT));
  }
  return { values, anchors };
}

/**
 * Scales each condition onto the target by the card's value ladder. The
 * ladder is the same whichever condition is being priced, so every
 * condition's curve is the one card curve rescaled, never a different shape.
 * Held out against realized sales, the sibling ratio predicted a condition's
 * price from the other conditions' sales about as well as a fitted exponent
 * and far better than treating every condition alike.
 */
function siblingRatioMultipliers(
  marketPrices: ReadonlyMap<Condition, number> | undefined,
  targetCondition: Condition,
):
  | { multipliers: Map<Condition, number>; anchorCondition?: Condition }
  | undefined {
  const ladder = marketPrices && conditionValueLadder(marketPrices);
  const targetValue = ladder?.values.get(targetCondition);
  if (!ladder || targetValue === undefined) return undefined;
  const multipliers = new Map(
    CONDITION_ORDER.map((condition) => [
      condition,
      targetValue / ladder.values.get(condition)!,
    ]),
  );
  const anchor = ladder.anchors.get(targetCondition);
  return {
    multipliers,
    ...(anchor === undefined ? {} : { anchorCondition: anchor }),
  };
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
  const information = conditionInformation(observations);
  const conditionTimeConnected = conditionTimelinesAreConnected(observations);
  const diagnostics = {
    observationCount: observations.length,
    observedConditionCount: conditionCount,
    conditionTimeConnected,
  };
  const fallback = () => {
    const sibling = siblingRatioMultipliers(
      options.siblingMarketPrices,
      targetCondition,
    );
    return sibling
      ? {
          multipliers: sibling.multipliers,
          diagnostics: {
            ...diagnostics,
            method: "sibling-market-ratio" as const,
            anchorCondition: sibling.anchorCondition,
          },
        }
      : {
          multipliers: multipliersForExponent(0, targetCondition),
          diagnostics: {
            ...diagnostics,
            method: "neutral-condition-fallback" as const,
            conditionExponent: 0,
          },
        };
  };

  if (
    observations.length <
      MODEL_PARAMETER_COUNT + MINIMUM_RESIDUAL_DEGREES_OF_FREEDOM ||
    conditionCount < 2 ||
    information < 1e-6 ||
    !conditionTimeConnected
  ) {
    return fallback();
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
    return fallback();
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

/**
 * Competing asks expressed in the target condition's terms with the same
 * multipliers that scale sales, so a better condition's ask competes at or
 * below its own price and a worse condition's only once it is cheap enough
 * to be worth the downgrade.
 */
export function normalizeListingsToTargetCondition<
  Listing extends { condition: Condition; price: number; shippingCost: number },
>(listings: Listing[], conditionMultipliers?: Map<Condition, number>): Listing[] {
  return listings.map((listing) => {
    const multiplier = conditionMultipliers?.get(listing.condition) ?? 1;
    return {
      ...listing,
      price: listing.price * multiplier,
      shippingCost: listing.shippingCost * multiplier,
    };
  });
}

/**
 * The delivered ask above which no listing of the product competes at any
 * condition's curve price: the highest sale expressed in the best graded
 * condition's terms. Scaling a curve's top price back through any condition's
 * multipliers lands on this same number, so one listings fetch capped here
 * serves every condition of the product. It refits for the best condition
 * rather than rescaling the target's multipliers, and rounds up to the cent,
 * so that every SKU of the product computes the identical number and the
 * batch cache sees one request.
 */
export function competingAskCeiling(
  sales: Sale[],
  options: ConditionNormalizationOptions = {},
): number | undefined {
  const saleTimes = sales
    .map((sale) => Date.parse(sale.orderDate))
    .filter(Number.isFinite);
  if (saleTimes.length === 0) return undefined;
  // Anchored to the newest sale, not the clock, so SKUs priced seconds apart
  // weigh the sales identically and compute the identical cap.
  const { multipliers } = fitTimeAwareZipfModelToConditions(
    sales,
    CONDITION_ORDER[0],
    { ...options, asOfTimestamp: options.asOfTimestamp ?? Math.max(...saleTimes) },
  );
  const prices = normalizeSalesToTargetCondition(sales, multipliers).map(
    ({ price }) => price,
  );
  return Math.ceil(Math.max(...prices) * 100) / 100;
}
