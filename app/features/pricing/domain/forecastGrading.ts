/**
 * Grades sell-time forecasts against realized sales. A SKU joins the cohort at
 * its first priced result that carries every forecast under test and is
 * followed for a fixed horizon. It sold if its quantity fell within the
 * horizon, or if it stopped being priced before the horizon ran out and is
 * out of stock now. A SKU that stopped being priced but is still in stock
 * left for another reason and is censored out. Two days of grace cover the
 * gap between one pricing and the next.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const REPRICING_GRACE_MS = 2 * DAY_MS;

export interface ForecastRecord {
  sku: number;
  pricedAt: number;
  quantity: number;
  /** Median sell days by forecast name; a missing forecast is absent. */
  forecasts: Record<string, number>;
}

export interface CohortMember {
  sku: number;
  sold: boolean;
  forecasts: Record<string, number>;
}

export interface ForecastGrade {
  count: number;
  /** Share of the cohort that realized a sale within the horizon. */
  soldShare: number;
  /** Share the forecast implied would sell within the horizon. */
  expectedShare: number;
  brier: number;
  deciles: {
    count: number;
    medianDays: number;
    soldShare: number;
    expectedShare: number;
  }[];
}

/** Probability of a sale within the horizon when sell time has this median. */
export function saleProbability(
  medianDays: number,
  horizonDays: number,
): number {
  return 1 - Math.pow(0.5, horizonDays / medianDays);
}

export function buildCohort(
  records: readonly ForecastRecord[],
  forecastNames: readonly string[],
  inStockSkus: ReadonlySet<number>,
  horizonDays: number,
): CohortMember[] {
  const bySku = new Map<number, ForecastRecord[]>();
  for (const record of records) {
    bySku.set(record.sku, [...(bySku.get(record.sku) ?? []), record]);
  }
  const end = records.reduce(
    (latest, record) => Math.max(latest, record.pricedAt),
    Number.NEGATIVE_INFINITY,
  );
  const horizonMs = horizonDays * DAY_MS;
  const members: CohortMember[] = [];
  for (const [sku, history] of bySku) {
    history.sort((left, right) => left.pricedAt - right.pricedAt);
    const start = history.find(
      (record) =>
        record.quantity > 0 &&
        forecastNames.every((name) => record.forecasts[name] > 0),
    );
    if (!start || end - start.pricedAt < horizonMs) continue;
    const window = history.filter(
      (record) =>
        record.pricedAt >= start.pricedAt &&
        record.pricedAt - start.pricedAt <= horizonMs,
    );
    const dropped = window.some(
      (record, index) =>
        index > 0 && record.quantity < window[index - 1].quantity,
    );
    const leftEarly =
      history.at(-1)!.pricedAt - start.pricedAt <
      horizonMs - REPRICING_GRACE_MS;
    if (!dropped && leftEarly && inStockSkus.has(sku)) continue;
    members.push({
      sku,
      sold: dropped || leftEarly,
      forecasts: start.forecasts,
    });
  }
  return members;
}

export function gradeForecast(
  members: readonly CohortMember[],
  forecastName: string,
  horizonDays: number,
): ForecastGrade {
  const sorted = [...members].sort(
    (left, right) =>
      left.forecasts[forecastName] - right.forecasts[forecastName],
  );
  const probability = (member: CohortMember) =>
    saleProbability(member.forecasts[forecastName], horizonDays);
  const share = (
    items: readonly CohortMember[],
    value: (member: CohortMember) => number,
  ) => items.reduce((sum, member) => sum + value(member), 0) / items.length;
  const deciles = Array.from({ length: 10 }, (_, decile) =>
    sorted.slice(
      Math.floor((decile * sorted.length) / 10),
      Math.floor(((decile + 1) * sorted.length) / 10),
    ),
  )
    .filter((slice) => slice.length > 0)
    .map((slice) => ({
      count: slice.length,
      medianDays: slice[Math.floor(slice.length / 2)].forecasts[forecastName],
      soldShare: share(slice, (member) => (member.sold ? 1 : 0)),
      expectedShare: share(slice, probability),
    }));
  return {
    count: members.length,
    soldShare: share(members, (member) => (member.sold ? 1 : 0)),
    expectedShare: share(members, probability),
    brier: share(
      members,
      (member) => (probability(member) - (member.sold ? 1 : 0)) ** 2,
    ),
    deciles,
  };
}
