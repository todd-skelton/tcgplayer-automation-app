import type { ListingSnapshot } from "~/core/db/repositories/productListingSnapshots.server";
import type { RecordedSale } from "~/core/db/repositories/productSales.server";
import type { WeeklySales } from "~/core/db/repositories/productWeeklySales.server";
import {
  INVENTORY_CONDITION_ORDER,
  type InventorySelectableCondition,
} from "~/core/utils/conditionOrder";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import { LATEST_SALES_HISTORY_DAYS } from "../algorithms/buyerArrivalRate";
import { fitTimeAwareZipfModelToConditions } from "../algorithms/conditionNormalization";
import { getEffectiveSalePrice } from "../algorithms/getEffectiveSalePrice";

/**
 * Forward test of condition normalization on direct sales. Everything dated
 * before a cutoff is evidence; the recorded sales that follow are the truth.
 * Each candidate turns the evidence into one value ladder for the card, the
 * evidence is normalized onto a condition with that ladder, and the
 * time-weighted median of the normalized prices is scored against every
 * later sale of the condition.
 *
 * Evidence is the recorded sales plus the weekly sales from the price
 * history for the weeks before the recorded sales begin, each week counted
 * as its transactions, so a year of every condition's sales feeds the fit
 * without double counting. Weights decay smoothly with age; nothing is cut
 * off or banded. Market prices enter only through the production candidate,
 * which uses them the way pricing does today.
 *
 * "unseen" removes the condition's own sales, weeks, and market price, the
 * case of a condition that has never traded, which is where the candidates
 * differ most. Its asks stay: a condition that never traded is still listed,
 * and whether those asks help is what the asks candidate tests.
 */

export type Candidate =
  | "production"
  | "pooled zipf"
  | "free rungs"
  | "pooled zipf + asks";
export const CANDIDATES: readonly Candidate[] = [
  "production",
  "pooled zipf",
  "free rungs",
  "pooled zipf + asks",
];
export type ForwardTestScenario = "seen" | "unseen";

export interface ForwardTestData {
  sales: readonly RecordedSale[];
  weeklySales: readonly WeeklySales[];
  listingSnapshots: readonly ListingSnapshot[];
}

export interface ForwardTestOptions {
  /** Moments that split evidence from truth, in epoch milliseconds. */
  cutoffs: number[];
  /** How far after each cutoff recorded sales count as truth. */
  horizonDays?: number;
  /** Half-life of an observation's weight as it ages, in days. */
  halfLifeDays?: number;
  /** Weight of prior evidence, in sales, when shrinking a card's exponent toward the population. */
  priorWeight?: number;
  /** Weight of one condition's cheapest ask, in sales, for the asks candidate. */
  askWeight?: number;
  /** Weighted evidence a card needs before it is scored. */
  minimumEvidence?: number;
}

export interface ForwardTestScore {
  productId: number;
  variant: string;
  language: string;
  condition: InventorySelectableCondition;
  scenario: ForwardTestScenario;
  candidate: Candidate;
  cutoff: number;
  predicted: number;
  actual: number;
  /** predicted / actual - 1 */
  signedError: number;
}

export interface ForwardTestSummary {
  scenario: ForwardTestScenario;
  candidate: Candidate;
  condition: InventorySelectableCondition | "all";
  count: number;
  medianRelativeError: number;
  medianSignedError: number;
  withinTenPercent: number;
  /** Share of scored sales where this candidate erred less than production. */
  betterThanProduction: number | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const DEFAULT_HORIZON_DAYS = 14;
const MAXIMUM_EXPONENT = 2;
/** Cross-condition evidence a card needs before its own exponent informs the population line. */
const INFORMATIVE_CARD_INFORMATION = 1;
/** Cards needed before a line, rather than a mean, is fitted through their exponents. */
const CARDS_FOR_A_LINE = 10;
/** No card's evidence outweighs this many sales in the population fit. */
const POPULATION_WEIGHT_CAP = 50;
/** The exponent assumed with no informative cards at all, about a 13% Lightly Played discount. */
const DEFAULT_EXPONENT = 0.2;
const LADDER: readonly InventorySelectableCondition[] = INVENTORY_CONDITION_ORDER;
const rankOf = (condition: Condition) => LADDER.indexOf(condition as InventorySelectableCondition) + 1;

function isLadderCondition(
  condition: Condition,
): condition is InventorySelectableCondition {
  return rankOf(condition) > 0;
}

/** One sale, or one week of sales, of a condition. */
interface Observation {
  condition: InventorySelectableCondition;
  /** Effective price per unit, shipping included. */
  price: number;
  time: number;
  /** Transactions the observation stands for: one for a sale, a week's count for a week. */
  count: number;
  /** The recorded sale behind it, when it is one. */
  sale?: RecordedSale;
}

interface CardEvidence {
  productId: number;
  variant: string;
  language: string;
  observations: Observation[];
  /** Latest market price per condition from the weekly sales, by week. */
  marketPrices: { time: number; condition: InventorySelectableCondition; price: number }[];
  asks: ListingSnapshot[];
}

const groupKey = (row: { productId: number; variant: string; language: string }) =>
  `${row.productId}|${row.variant}|${row.language}`;

/** Recorded sales and, before they begin, the weekly sales, as one series per card. */
export function gatherEvidence(data: ForwardTestData): CardEvidence[] {
  const cards = new Map<string, CardEvidence>();
  const card = (row: { productId: number; variant: string; language: string }) => {
    const key = groupKey(row);
    let evidence = cards.get(key);
    if (!evidence) {
      evidence = {
        productId: row.productId,
        variant: row.variant,
        language: row.language,
        observations: [],
        marketPrices: [],
        asks: [],
      };
      cards.set(key, evidence);
    }
    return evidence;
  };

  const firstRecordedSale = new Map<string, number>();
  for (const sale of data.sales) {
    if (!isLadderCondition(sale.condition)) continue;
    const time = Date.parse(sale.orderDate);
    const price = getEffectiveSalePrice(sale);
    if (!Number.isFinite(time) || !(price > 0)) continue;
    card(sale).observations.push({
      condition: sale.condition,
      price,
      time,
      count: 1,
      sale,
    });
    const key = groupKey(sale);
    firstRecordedSale.set(key, Math.min(firstRecordedSale.get(key) ?? Infinity, time));
  }

  for (const week of data.weeklySales) {
    if (!isLadderCondition(week.condition)) continue;
    const weekStart = Date.parse(week.weekStart);
    if (!Number.isFinite(weekStart)) continue;
    const evidence = card(week);
    const time = weekStart + WEEK_MS / 2;
    if (week.tcgMarketPrice && week.tcgMarketPrice > 0) {
      evidence.marketPrices.push({ time, condition: week.condition, price: week.tcgMarketPrice });
    }
    // Recorded sales cover the weeks from the first one onward.
    if (weekStart + WEEK_MS > (firstRecordedSale.get(groupKey(week)) ?? Infinity)) continue;
    const low = week.lowSalePriceWithShipping ?? week.lowSalePrice;
    const high = week.highSalePriceWithShipping ?? week.highSalePrice;
    if (!(low && low > 0 && high && high > 0)) continue;
    evidence.observations.push({
      condition: week.condition,
      price: Math.sqrt(low * high),
      time,
      count: week.transactions,
    });
  }

  for (const snapshot of data.listingSnapshots) {
    if (!isLadderCondition(snapshot.condition)) continue;
    card(snapshot).asks.push(snapshot);
  }

  for (const evidence of cards.values()) {
    evidence.observations.sort((left, right) => left.time - right.time);
  }
  return [...cards.values()];
}

/** Weekly cutoffs across the recorded sales, each leaving a horizon of truth after it. */
export function weeklyCutoffs(
  sales: readonly RecordedSale[],
  options: Pick<ForwardTestOptions, "horizonDays"> = {},
): number[] {
  const times = sales.map((sale) => Date.parse(sale.orderDate)).filter(Number.isFinite);
  if (times.length === 0) return [];
  const first = Math.min(...times);
  const last = Math.max(...times) - (options.horizonDays ?? DEFAULT_HORIZON_DAYS) * DAY_MS;
  const cutoffs: number[] = [];
  for (let cutoff = first; cutoff <= last; cutoff += WEEK_MS) cutoffs.push(cutoff);
  return cutoffs;
}

// ---------------------------------------------------------------------------
// Fitting

interface Weighted extends Observation {
  weight: number;
}

/** Gaussian elimination with partial pivoting; undefined when singular. */
function solve(matrix: number[][], vector: number[]): number[] | undefined {
  const n = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column] / rows[column][column];
      for (let k = column; k <= n; k += 1) rows[row][k] -= factor * rows[column][k];
    }
  }
  return rows.map((row, index) => row[n] / row[index]);
}

/**
 * Robust weighted least squares of log price on the given features, with
 * Huber reweighting so one stray sale cannot steer the fit.
 */
function robustFit(
  rows: { features: number[]; target: number; weight: number }[],
): number[] | undefined {
  if (rows.length === 0) return undefined;
  const width = rows[0].features.length;
  let weights = rows.map((row) => row.weight);
  let coefficients: number[] | undefined;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const matrix = Array.from({ length: width }, () => Array<number>(width).fill(0));
    const vector = Array<number>(width).fill(0);
    rows.forEach((row, index) => {
      for (let left = 0; left < width; left += 1) {
        vector[left] += weights[index] * row.features[left] * row.target;
        for (let right = 0; right < width; right += 1) {
          matrix[left][right] += weights[index] * row.features[left] * row.features[right];
        }
      }
    });
    coefficients = solve(matrix, vector);
    if (!coefficients) return undefined;
    const fitted = coefficients;
    const residuals = rows.map(
      (row) => row.target - row.features.reduce((sum, value, k) => sum + value * fitted[k], 0),
    );
    const absolute = residuals.map(Math.abs).sort((left, right) => left - right);
    const scale = (absolute[Math.floor(absolute.length / 2)] || 0.01) * 1.4826;
    weights = rows.map(
      (row, index) =>
        row.weight * Math.min(1, (1.345 * scale) / Math.max(Math.abs(residuals[index]), 1e-10)),
    );
  }
  return coefficients;
}

interface ExponentFit {
  /** Fitted log price at the cutoff, Near Mint's when more than one condition is present. */
  level: number;
  exponent: number;
  /** Weighted spread of log rank in the evidence: how much the card says about its own exponent. */
  information: number;
}

/** log price = level + trend * years before cutoff − exponent * log rank */
function fitExponent(evidence: Weighted[], cutoff: number): ExponentFit | undefined {
  const total = evidence.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return undefined;
  const meanLogRank =
    evidence.reduce((sum, row) => sum + row.weight * Math.log(rankOf(row.condition)), 0) / total;
  const information = evidence.reduce(
    (sum, row) => sum + row.weight * (Math.log(rankOf(row.condition)) - meanLogRank) ** 2,
    0,
  );
  const conditions = new Set(evidence.map((row) => row.condition)).size;
  const rows = (withTrend: boolean) =>
    evidence.map((row) => ({
      features: [
        1,
        ...(withTrend ? [(row.time - cutoff) / YEAR_MS] : []),
        ...(conditions > 1 ? [Math.log(rankOf(row.condition))] : []),
      ],
      target: Math.log(row.price),
      weight: row.weight,
    }));
  // Evidence from a single moment cannot carry a trend; fit the level alone.
  const trended = robustFit(rows(true));
  const coefficients = trended ?? robustFit(rows(false));
  if (!coefficients) return undefined;
  const exponent = conditions > 1
    ? Math.max(0, Math.min(MAXIMUM_EXPONENT, -coefficients[coefficients.length - 1]))
    : 0;
  // With one condition the level is that condition's own; the prior's line is
  // shallow enough that the difference from Near Mint's does not matter.
  return { level: coefficients[0], exponent, information: conditions > 1 ? information : 0 };
}

/** Pool adjacent violators: the largest non-increasing sequence nearest the values, by weight. */
function nonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: { value: number; weight: number; size: number }[] = [];
  values.forEach((value, index) => {
    blocks.push({ value, weight: weights[index], size: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 1].value > blocks[blocks.length - 2].value) {
      const last = blocks.pop()!;
      const previous = blocks.pop()!;
      const weight = last.weight + previous.weight;
      blocks.push({
        value: weight > 0
          ? (last.value * last.weight + previous.value * previous.weight) / weight
          : (last.value + previous.value) / 2,
        weight,
        size: last.size + previous.size,
      });
    }
  });
  return blocks.flatMap((block) => Array<number>(block.size).fill(block.value));
}

/**
 * The population's exponent as a smooth function of a card's value: fitted
 * across the cards whose own evidence spans conditions, weighted by how much
 * each says. Cheap cards flatten toward every condition selling for the
 * listing floor; valuable cards steepen. A straight line in log value, no
 * bands.
 */
export interface PopulationPrior {
  intercept: number;
  slope: number;
}

export function fitPopulationPrior(
  fits: readonly ExponentFit[],
): PopulationPrior {
  const informative = fits.filter((fit) => fit.information >= INFORMATIVE_CARD_INFORMATION);
  if (informative.length < CARDS_FOR_A_LINE) {
    const total = informative.reduce((sum, fit) => sum + fit.information, 0);
    return {
      intercept: total > 0
        ? informative.reduce((sum, fit) => sum + fit.information * fit.exponent, 0) / total
        : DEFAULT_EXPONENT,
      slope: 0,
    };
  }
  const coefficients = robustFit(
    informative.map((fit) => ({
      features: [1, fit.level],
      target: fit.exponent,
      weight: Math.min(fit.information, POPULATION_WEIGHT_CAP),
    })),
  );
  return coefficients
    ? { intercept: coefficients[0], slope: coefficients[1] }
    : { intercept: DEFAULT_EXPONENT, slope: 0 };
}

const priorExponent = (prior: PopulationPrior, level: number) =>
  Math.max(0, Math.min(MAXIMUM_EXPONENT, prior.intercept + prior.slope * level));

/** Log value of each condition relative to Near Mint, non-increasing by construction. */
type Rungs = Map<InventorySelectableCondition, number>;

const zipfRungs = (exponent: number): Rungs =>
  new Map(LADDER.map((condition) => [condition, -exponent * Math.log(rankOf(condition))]));

function pooledZipfRungs(
  evidence: Weighted[],
  cutoff: number,
  prior: PopulationPrior,
  priorWeight: number,
): Rungs | undefined {
  const fit = fitExponent(evidence, cutoff);
  if (!fit) return undefined;
  const pooled =
    (fit.information * fit.exponent + priorWeight * priorExponent(prior, fit.level)) /
    (fit.information + priorWeight);
  return zipfRungs(pooled);
}

/**
 * One free step per condition, monotone, each shrunk toward the pooled Zipf
 * rung by the prior weight, so a condition with no evidence takes the Zipf
 * value and one with plenty takes its own.
 */
function freeRungs(
  evidence: Weighted[],
  cutoff: number,
  prior: PopulationPrior,
  priorWeight: number,
): Rungs | undefined {
  const zipf = pooledZipfRungs(evidence, cutoff, prior, priorWeight);
  if (!zipf) return undefined;
  const present = LADDER.filter((condition) =>
    evidence.some((row) => row.condition === condition),
  );
  const columns: InventorySelectableCondition[] = present.slice(1);
  const coefficients = robustFit(
    evidence.map((row) => ({
      features: [
        1,
        (row.time - cutoff) / YEAR_MS,
        ...columns.map((condition) => (row.condition === condition ? 1 : 0)),
      ],
      target: Math.log(row.price),
      weight: row.weight,
    })),
  );
  if (!coefficients) return zipf;
  const weightOf = (condition: InventorySelectableCondition) =>
    evidence.filter((row) => row.condition === condition).reduce((sum, row) => sum + row.weight, 0);
  // The steps are read relative to the best condition present, which sits on its Zipf rung.
  const anchorRung = zipf.get(present[0]) ?? 0;
  const raw = new Map<InventorySelectableCondition, number>(
    present.map((condition) => [
      condition,
      condition === present[0] ? anchorRung : anchorRung + coefficients[2 + columns.indexOf(condition)],
    ]),
  );
  const shrunk = LADDER.map((condition) => {
    const own = raw.get(condition);
    const weight = weightOf(condition);
    const target = zipf.get(condition)!;
    return own === undefined ? target : (weight * own + priorWeight * target) / (weight + priorWeight);
  });
  const monotone = nonIncreasing(shrunk, LADDER.map((condition) => weightOf(condition) + priorWeight));
  return new Map(LADDER.map((condition, index) => [condition, monotone[index]]));
}

function productionRungs(
  evidence: Weighted[],
  marketPrices: Map<Condition, number>,
  target: InventorySelectableCondition,
  cutoff: number,
): Rungs | undefined {
  const sales = evidence.flatMap((row) => (row.sale ? [row.sale] : []));
  const { multipliers } = fitTimeAwareZipfModelToConditions(sales, target, {
    asOfTimestamp: cutoff,
    siblingMarketPrices: marketPrices,
  });
  // Production scales onto the target; expressed as rungs relative to Near Mint.
  const nearMint = multipliers.get("Near Mint");
  if (!nearMint) return undefined;
  return new Map(
    LADDER.map((condition) => [condition, Math.log(nearMint / (multipliers.get(condition) ?? 1))]),
  );
}

/** Weighted median of the evidence normalized onto the target condition. */
function normalizedMedian(
  evidence: Weighted[],
  rungs: Rungs,
  target: InventorySelectableCondition,
): number | undefined {
  const rows = evidence
    .map((row) => ({
      price: row.price * Math.exp(rungs.get(target)! - rungs.get(row.condition)!),
      weight: row.weight,
    }))
    .sort((left, right) => left.price - right.price);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return undefined;
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.weight;
    if (cumulative >= total / 2) return row.price;
  }
  return rows.at(-1)?.price;
}

// ---------------------------------------------------------------------------

export function runConditionLadderForwardTest(
  data: ForwardTestData,
  options: ForwardTestOptions,
): ForwardTestScore[] {
  const horizon = (options.horizonDays ?? DEFAULT_HORIZON_DAYS) * DAY_MS;
  const halfLife = (options.halfLifeDays ?? LATEST_SALES_HISTORY_DAYS) * DAY_MS;
  const priorWeight = options.priorWeight ?? 5;
  const askWeight = options.askWeight ?? 1;
  const minimumEvidence = options.minimumEvidence ?? 3;
  const cards = gatherEvidence(data);
  const scores: ForwardTestScore[] = [];

  for (const cutoff of options.cutoffs) {
    const weigh = (observations: Observation[]): Weighted[] =>
      observations
        .filter((row) => row.time < cutoff)
        .map((row) => ({
          ...row,
          weight: row.count * Math.pow(0.5, (cutoff - row.time) / halfLife),
        }));
    const evidenceByCard = cards.map((card) => weigh(card.observations));
    const prior = fitPopulationPrior(
      evidenceByCard.flatMap((evidence) => {
        const fit = evidence.length > 0 ? fitExponent(evidence, cutoff) : undefined;
        return fit ? [fit] : [];
      }),
    );

    cards.forEach((card, cardIndex) => {
      const evidence = evidenceByCard[cardIndex];
      const truth = card.observations.filter(
        (row) => row.sale && row.time >= cutoff && row.time < cutoff + horizon,
      );
      if (truth.length === 0) return;
      const marketAt = (exclude?: InventorySelectableCondition) => {
        const latest = new Map<Condition, { time: number; price: number }>();
        for (const point of card.marketPrices) {
          if (point.time >= cutoff || point.condition === exclude) continue;
          const current = latest.get(point.condition);
          if (!current || point.time > current.time) latest.set(point.condition, point);
        }
        return new Map([...latest].map(([condition, point]) => [condition, point.price]));
      };
      const asksAt = (): Weighted[] => {
        const latest = new Map<InventorySelectableCondition, ListingSnapshot>();
        for (const snapshot of card.asks) {
          const time = Date.parse(snapshot.observedOn);
          if (!(time < cutoff) || cutoff - time > 14 * DAY_MS) continue;
          if (!isLadderCondition(snapshot.condition)) continue;
          const current = latest.get(snapshot.condition);
          if (!current || snapshot.observedOn > current.observedOn) latest.set(snapshot.condition, snapshot);
        }
        return [...latest.values()].flatMap((snapshot) =>
          snapshot.cheapestDeliveredPrice && snapshot.cheapestDeliveredPrice > 0
            ? [{
                condition: snapshot.condition as InventorySelectableCondition,
                price: snapshot.cheapestDeliveredPrice,
                time: cutoff,
                count: 1,
                weight: askWeight,
              }]
            : [],
        );
      };

      const pooledRungs = (cardEvidence: Weighted[], candidate: Candidate): Rungs | undefined => {
        switch (candidate) {
          case "pooled zipf":
            return pooledZipfRungs(cardEvidence, cutoff, prior, priorWeight);
          case "free rungs":
            return freeRungs(cardEvidence, cutoff, prior, priorWeight);
          case "pooled zipf + asks":
            return pooledZipfRungs([...cardEvidence, ...asksAt()], cutoff, prior, priorWeight);
          case "production":
            return undefined;
        }
      };
      // With every condition seen the pooled ladders are the same for every target.
      const seenRungs = new Map<Candidate, Rungs | undefined>();
      for (const condition of LADDER) {
        const actuals = truth.filter((row) => row.condition === condition);
        if (actuals.length === 0) continue;
        for (const scenario of ["seen", "unseen"] as const) {
          const seen = scenario === "seen";
          const cardEvidence = seen
            ? evidence
            : evidence.filter((row) => row.condition !== condition);
          if (cardEvidence.reduce((sum, row) => sum + row.weight, 0) < minimumEvidence) continue;
          const rungsFor = (candidate: Candidate): Rungs | undefined => {
            if (candidate === "production") {
              return productionRungs(cardEvidence, marketAt(seen ? undefined : condition), condition, cutoff);
            }
            if (!seen) return pooledRungs(cardEvidence, candidate);
            if (!seenRungs.has(candidate)) seenRungs.set(candidate, pooledRungs(cardEvidence, candidate));
            return seenRungs.get(candidate);
          };
          for (const candidate of CANDIDATES) {
            const rungs = rungsFor(candidate);
            const predicted = rungs && normalizedMedian(cardEvidence, rungs, condition);
            if (!(predicted && predicted > 0)) continue;
            for (const actual of actuals) {
              scores.push({
                productId: card.productId,
                variant: card.variant,
                language: card.language,
                condition,
                scenario,
                candidate,
                cutoff,
                predicted,
                actual: actual.price,
                signedError: predicted / actual.price - 1,
              });
            }
          }
        }
      }
    });
  }
  return scores;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const pairKey = (score: ForwardTestScore) =>
  `${score.productId}|${score.variant}|${score.language}|${score.condition}|${score.scenario}|${score.cutoff}|${score.actual}`;

/** One row per scenario, candidate, and condition, plus an "all" row per candidate. */
export function summarizeForwardTest(
  scores: readonly ForwardTestScore[],
): ForwardTestSummary[] {
  const productionError = new Map<string, number>();
  for (const score of scores) {
    if (score.candidate === "production") productionError.set(pairKey(score), Math.abs(score.signedError));
  }
  const summarize = (
    rows: ForwardTestScore[],
    scenario: ForwardTestScenario,
    candidate: Candidate,
    condition: ForwardTestSummary["condition"],
  ): ForwardTestSummary => {
    const relative = rows.map((row) => Math.abs(row.signedError));
    const paired = rows.filter((row) => productionError.has(pairKey(row)));
    return {
      scenario,
      candidate,
      condition,
      count: rows.length,
      medianRelativeError: median(relative),
      medianSignedError: median(rows.map((row) => row.signedError)),
      withinTenPercent: relative.filter((error) => error <= 0.1).length / relative.length,
      betterThanProduction:
        candidate === "production" || paired.length === 0
          ? undefined
          : paired.filter((row) => Math.abs(row.signedError) < productionError.get(pairKey(row))!).length /
            paired.length,
    };
  };
  const summaries: ForwardTestSummary[] = [];
  for (const scenario of ["seen", "unseen"] as const) {
    for (const candidate of CANDIDATES) {
      const rows = scores.filter((score) => score.scenario === scenario && score.candidate === candidate);
      if (rows.length === 0) continue;
      summaries.push(summarize(rows, scenario, candidate, "all"));
      for (const condition of LADDER) {
        const byCondition = rows.filter((score) => score.condition === condition);
        if (byCondition.length > 0) summaries.push(summarize(byCondition, scenario, candidate, condition));
      }
    }
  }
  return summaries;
}
