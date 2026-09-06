import policy from "./gradeModelPolicy.json";

export type GradeCohort = {
  game: string | null;
  language: string | null;
  set: string | null;
  edition: string | null;
  finish: string | null;
  stamp: string | null;
  grader: string;
  labelFamily: string;
};
export type GradeSale = {
  eventId: string | null;
  cardId: string;
  cohort: GradeCohort;
  grade: number;
  soldOn: string;
  capturedAt: string;
  amount: number;
  currency: string;
  basis: "item-plus-shipping";
  kind: "transaction" | "listing-average" | "provider-estimate";
  quantity: number;
  verified: boolean;
  sourceRevision: string;
};
export type GradePair = {
  anchor: number;
  target: number;
  cards: number;
  medianLogRatio: number;
  fittedLogRatio: number;
};
export type GradeModel = {
  version: "paired-log-grade-v1";
  policyVersion: string;
  cohort: string;
  fittedAt: string;
  pairs: GradePair[];
  lineage: { revisions: string[]; eventIds: string[]; excludedCards: string[] };
};
export type GradePrediction = {
  kind: "direct" | "borrowed";
  method: "direct" | "ratio" | "fitted";
  midpoint: number;
  directEffectiveCount: number;
  borrowedWeight: number;
  anchorGrade: number | null;
  trainingCards: number;
  evidence: string[];
};
const DAY = 86400000;
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;
const text = (value: string | null) =>
  typeof value === "string" && value.trim() && value.length <= 200
    ? value.trim().toLowerCase()
    : null;
export function gradeCohortKey(cohort: GradeCohort): string | null {
  const fields = [
    cohort.game,
    cohort.language,
    cohort.set,
    cohort.edition,
    cohort.finish,
    cohort.stamp,
    cohort.grader,
    cohort.labelFamily,
  ].map(text);
  return fields.every(Boolean) ? JSON.stringify(fields) : null;
}
export function eligibleGradeSale(sale: GradeSale) {
  return (
    sale.verified &&
    !!sale.eventId &&
    sale.eventId.length <= 200 &&
    !!text(sale.cardId) &&
    !!gradeCohortKey(sale.cohort) &&
    validDate(sale.soldOn) &&
    Number.isFinite(Date.parse(sale.capturedAt)) &&
    sale.soldOn <= sale.capturedAt.slice(0, 10) &&
    sale.amount >= 0.01 &&
    sale.amount < 1e9 &&
    sale.currency === "USD" &&
    sale.basis === "item-plus-shipping" &&
    ["transaction", "listing-average"].includes(sale.kind) &&
    sale.quantity === 1 &&
    Number.isFinite(sale.grade) &&
    sale.grade >= 1 &&
    sale.grade <= 10 &&
    (sale.grade * 2) % 1 === 0 &&
    !!text(sale.sourceRevision)
  );
}
// Capture time, not sale date alone, establishes whether evidence was available at a forecast cutoff.
export function availableGradeSales(
  sales: readonly GradeSale[],
  cutoff: string,
) {
  if (!Number.isFinite(Date.parse(cutoff)) || sales.length > 20000)
    throw new Error("Provide a bounded grade dataset and valid cutoff.");
  const groups = new Map<string, GradeSale[]>();
  for (const sale of sales) {
    if (
      !eligibleGradeSale(sale) ||
      Date.parse(sale.capturedAt) > Date.parse(cutoff) ||
      sale.soldOn >= cutoff.slice(0, 10)
    )
      continue;
    const group = groups.get(sale.eventId!) ?? [];
    group.push(sale);
    groups.set(sale.eventId!, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, copies]) => {
      const signature = (sale: GradeSale) =>
        JSON.stringify([
          sale.cardId,
          gradeCohortKey(sale.cohort),
          sale.grade,
          sale.soldOn,
          sale.amount,
          sale.currency,
          sale.basis,
        ]);
      if (copies.some((sale) => signature(sale) !== signature(copies[0])))
        return [];
      return [
        copies.sort(
          (a, b) =>
            a.capturedAt.localeCompare(b.capturedAt) ||
            a.sourceRevision.localeCompare(b.sourceRevision),
        )[0],
      ];
    });
}
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.floor(sorted.length / 2)]) /
    2
  );
}
function weightedValue(sales: GradeSale[], cutoff: string) {
  const rows = sales
    .map((sale) => ({
      sale,
      weight:
        2 **
        (-(Date.parse(cutoff) - Date.parse(sale.soldOn)) /
          DAY /
          policy.halfLifeDays),
    }))
    .sort(
      (a, b) =>
        a.sale.amount - b.sale.amount ||
        a.sale.eventId!.localeCompare(b.sale.eventId!),
    );
  const effective = rows.reduce((sum, row) => sum + row.weight, 0);
  let weight = 0;
  for (const row of rows) {
    weight += row.weight;
    if (weight >= effective / 2) return { value: row.sale.amount, effective };
  }
  return { value: null, effective: 0 };
}
function borrowable(cohort: GradeCohort, grade: number) {
  // Premium labels and PSA 1 are separate phenomena, never rungs on a universal ladder.
  return (
    text(cohort.labelFamily) === "standard" &&
    !(text(cohort.grader) === "psa" && (grade === 1 || grade === 9.5))
  );
}
export function fitGradeModel(
  sales: readonly GradeSale[],
  cohort: GradeCohort,
  cutoff: string,
  excludeCards: readonly string[] = [],
): GradeModel | null {
  const key = gradeCohortKey(cohort);
  if (!key || text(cohort.labelFamily) !== "standard") return null;
  const excluded = new Set(excludeCards);
  const eligible = availableGradeSales(sales, cutoff).filter(
    (s) =>
      gradeCohortKey(s.cohort) === key &&
      !excluded.has(s.cardId) &&
      borrowable(cohort, s.grade) &&
      Date.parse(cutoff) - Date.parse(s.soldOn) <= policy.maximumAgeDays * DAY,
  );
  const cards = new Map<string, Map<number, GradeSale[]>>();
  for (const sale of eligible) {
    const grades = cards.get(sale.cardId) ?? new Map();
    const rows = grades.get(sale.grade) ?? [];
    rows.push(sale);
    grades.set(sale.grade, rows);
    cards.set(sale.cardId, grades);
  }
  const effects = new Map<
    string,
    { anchor: number; target: number; values: number[] }
  >();
  for (const grades of cards.values()) {
    const values = [...grades]
      .sort(([a], [b]) => a - b)
      .map(([grade, rows]) => ({
        grade,
        value: weightedValue(rows, cutoff).value!,
      }));
    for (const anchor of values)
      for (const target of values)
        if (anchor.grade !== target.grade) {
          const pairKey = `${anchor.grade}:${target.grade}`;
          const pair = effects.get(pairKey) ?? {
            anchor: anchor.grade,
            target: target.grade,
            values: [],
          };
          pair.values.push(Math.log(target.value / anchor.value));
          effects.set(pairKey, pair);
        }
  }
  const pairs = [...effects.values()]
    .filter((p) => p.values.length >= policy.minimumTrainingCardsPerGradePair)
    .sort((a, b) => a.anchor - b.anchor || a.target - b.target)
    .map((p) => {
      const prior = median(p.values)!;
      const mean = p.values.reduce((a, b) => a + b, 0) / p.values.length;
      const information =
        p.values.length / (p.values.length + policy.priorEffectiveSales);
      return {
        anchor: p.anchor,
        target: p.target,
        cards: p.values.length,
        medianLogRatio: prior,
        fittedLogRatio: prior + information * (mean - prior),
      };
    });
  if (!pairs.length) return null;
  const used = eligible.filter((s) =>
    pairs.some(
      (pair) =>
        (s.grade === pair.anchor || s.grade === pair.target) &&
        cards.get(s.cardId)!.has(pair.anchor) &&
        cards.get(s.cardId)!.has(pair.target),
    ),
  );
  return {
    version: "paired-log-grade-v1",
    policyVersion: policy.version,
    cohort: key,
    fittedAt: cutoff,
    pairs,
    lineage: {
      revisions: [...new Set(used.map((s) => s.sourceRevision))].sort(),
      eventIds: used.map((s) => s.eventId!).sort(),
      excludedCards: [...excluded].sort(),
    },
  };
}
export function predictGrade(input: {
  method: GradePrediction["method"];
  model: GradeModel | null;
  history: readonly GradeSale[];
  cardId: string;
  cohort: GradeCohort;
  grade: number;
  cutoff: string;
}): GradePrediction | null {
  const key = gradeCohortKey(input.cohort);
  if (!key) return null;
  const history = availableGradeSales(input.history, input.cutoff).filter(
    (s) =>
      s.cardId === input.cardId &&
      gradeCohortKey(s.cohort) === key &&
      Date.parse(input.cutoff) - Date.parse(s.soldOn) <=
        policy.maximumAgeDays * DAY,
  );
  const direct = history.filter((s) => s.grade === input.grade);
  const observed = weightedValue(direct, input.cutoff);
  const directPrediction = (): GradePrediction | null =>
    observed.value && direct.length >= 3 && observed.effective >= 2.5
      ? {
          kind: "direct",
          method: input.method,
          midpoint: observed.value,
          directEffectiveCount: observed.effective,
          borrowedWeight: 0,
          anchorGrade: null,
          trainingCards: 0,
          evidence: direct.map((s) => s.eventId!),
        }
      : null;
  if (input.method === "direct") return directPrediction();
  const model = input.model;
  if (
    !model ||
    model.version !== "paired-log-grade-v1" ||
    model.policyVersion !== policy.version ||
    model.cohort !== key ||
    !Number.isFinite(Date.parse(model.fittedAt)) ||
    Date.parse(model.fittedAt) > Date.parse(input.cutoff) ||
    !borrowable(input.cohort, input.grade)
  )
    return directPrediction();
  const anchors = model.pairs
    .filter(
      (p) =>
        p.target === input.grade &&
        Number.isInteger(p.cards) &&
        p.cards >= policy.minimumTrainingCardsPerGradePair &&
        Number.isFinite(p.medianLogRatio) &&
        Number.isFinite(p.fittedLogRatio) &&
        borrowable(input.cohort, p.anchor),
    )
    .map((pair) => {
      const rows = history.filter((s) => s.grade === pair.anchor);
      return { pair, rows, price: weightedValue(rows, input.cutoff) };
    })
    .filter(
      (a) => a.rows.length >= 3 && a.price.effective >= 2.5 && a.price.value,
    )
    .sort(
      (a, b) =>
        b.price.effective - a.price.effective ||
        b.pair.cards - a.pair.cards ||
        a.pair.anchor - b.pair.anchor,
    );
  const anchor = anchors[0];
  if (!anchor) return directPrediction();
  const ratio =
    input.method === "ratio"
      ? anchor.pair.medianLogRatio
      : anchor.pair.fittedLogRatio;
  const borrowed = Math.log(anchor.price.value!) + ratio;
  const strength =
    (policy.priorEffectiveSales * anchor.pair.cards) /
    (anchor.pair.cards + policy.priorEffectiveSales);
  // A simple ratio baseline uses direct evidence when sufficient; the fitted candidate shrinks smoothly.
  if (input.method === "ratio" && directPrediction()) return directPrediction();
  const borrowedWeight =
    input.method === "ratio" ? 1 : strength / (strength + observed.effective);
  const midpoint = Math.exp(
    borrowedWeight * borrowed +
      (1 - borrowedWeight) * Math.log(observed.value ?? Math.exp(borrowed)),
  );
  if (!Number.isFinite(midpoint) || midpoint <= 0 || midpoint >= 1e9)
    return null;
  return {
    kind: "borrowed",
    method: input.method,
    midpoint,
    directEffectiveCount: observed.effective,
    borrowedWeight,
    anchorGrade: anchor.pair.anchor,
    trainingCards: anchor.pair.cards,
    evidence: [...direct, ...anchor.rows].map((s) => s.eventId!).sort(),
  };
}
