import assert from "node:assert/strict";
import {
  availableGradeSales,
  fitGradeModel,
  predictGrade,
  type GradeCohort,
  type GradeSale,
} from "./gradeModel";
import { evaluateGradeModel } from "./gradeModelEvaluation";
import { reproduceGradeDiagnostic } from "./evaluateGradeModel.server";

const cohort: GradeCohort = {
  game: "Pokemon",
  language: "Japanese",
  set: "Test set",
  edition: "Unlimited",
  finish: "Holo",
  stamp: "None",
  grader: "PSA",
  labelFamily: "standard",
};
const sale = (
  cardId: string,
  grade: number,
  amount: number,
  id: string,
  soldOn = "2026-06-15",
  capturedAt = "2026-06-16T00:00:00Z",
): GradeSale => ({
  eventId: id,
  cardId,
  cohort,
  grade,
  soldOn,
  capturedAt,
  amount,
  currency: "USD",
  basis: "item-plus-shipping",
  kind: "transaction",
  quantity: 1,
  verified: true,
  sourceRevision: `snapshot-${capturedAt}`,
});
const training = Array.from({ length: 8 }, (_, card) =>
  [9, 10].flatMap((grade) =>
    [0.99, 1, 1.01].map((multiplier, i) =>
      sale(
        `card-${card}`,
        grade,
        (100 + card * 10) * (grade === 10 ? 2 : 1) * multiplier,
        `train-${card}-${grade}-${i}`,
      ),
    ),
  ),
).flat();
const cutoff = "2026-07-01T00:00:00Z";
const model = fitGradeModel(training, cohort, cutoff)!;
assert.ok(model);
assert.deepEqual(
  fitGradeModel(
    [...training, sale("unpaired", 9, 999, "unused-single-grade")],
    cohort,
    cutoff,
  ),
  model,
);
assert.deepEqual(fitGradeModel([...training].reverse(), cohort, cutoff), model);
const history = [0, 1, 2, 3].map((i) =>
  sale("target", 10, 200, `target-10-${i}`),
);
const input = {
  method: "fitted" as const,
  model,
  history,
  cardId: "target",
  cohort,
  grade: 9,
  cutoff,
};
const sparse = predictGrade(input)!;
assert.deepEqual(
  predictGrade({ ...input, model: JSON.parse(JSON.stringify(model)) }),
  sparse,
);
assert.equal(
  predictGrade({ ...input, model: { ...model, fittedAt: "invalid" } }),
  null,
);
assert.equal(
  predictGrade({ ...input, model: { ...model, policyVersion: "unknown" } }),
  null,
);
assert.equal(sparse.kind, "borrowed");
assert.ok(Math.abs(sparse.midpoint - 100) < 1e-9);
assert.equal(predictGrade({ ...input, method: "direct" }), null);
const few = predictGrade({
  ...input,
  history: [
    ...history,
    ...Array.from({ length: 4 }, (_, i) =>
      sale("target", 9, 125, `target-9-${i}`),
    ),
  ],
})!;
const many = predictGrade({
  ...input,
  history: [
    ...history,
    ...Array.from({ length: 100 }, (_, i) =>
      sale("target", 9, 125, `target-9-${i}`),
    ),
  ],
})!;
assert.ok(few.midpoint > 100 && few.midpoint < 125);
assert.ok(
  many.borrowedWeight < few.borrowedWeight && Math.abs(many.midpoint - 125) < 1,
);
assert.equal(predictGrade({ ...input, grade: 1 }), null);
assert.equal(
  predictGrade({ ...input, cohort: { ...cohort, grader: "CGC" } }),
  null,
);
assert.equal(
  predictGrade({ ...input, cohort: { ...cohort, labelFamily: "Pristine" } }),
  null,
);
assert.equal(
  predictGrade({ ...input, cohort: { ...cohort, language: "English" } }),
  null,
);
assert.equal(
  fitGradeModel(training, { ...cohort, finish: null }, cutoff),
  null,
);
assert.equal(
  fitGradeModel(training, { ...cohort, labelFamily: "Black Label" }, cutoff),
  null,
);
const inverted = training.map((s) => ({
  ...s,
  amount: s.grade === 10 ? s.amount / 4 : s.amount,
}));
assert.ok(
  fitGradeModel(inverted, cohort, cutoff)!.pairs.find(
    (p) => p.anchor === 9 && p.target === 10,
  )!.fittedLogRatio < 0,
  "No imposed monotonic grade ladder",
);

const future = {
  ...history[0],
  eventId: "not-yet-observed",
  amount: 50000,
  capturedAt: "2026-07-02T00:00:00Z",
};
assert.deepEqual(
  predictGrade({ ...input, history: [...history, future] }),
  sparse,
);
assert.deepEqual(fitGradeModel([...training, future], cohort, cutoff), model);
const repeated = availableGradeSales(
  [history[0], { ...history[0], sourceRevision: "second-copy" }],
  cutoff,
);
assert.equal(repeated.length, 1);
assert.equal(
  availableGradeSales([history[0], { ...history[0], amount: 999 }], cutoff)
    .length,
  0,
);
assert.equal(
  availableGradeSales(
    [
      { ...history[0], verified: false },
      { ...history[1], kind: "provider-estimate" },
      { ...history[2], quantity: 2 },
      { ...history[3], eventId: null },
    ],
    cutoff,
  ).length,
  0,
);
assert.equal(
  predictGrade({
    ...input,
    model: { ...model, fittedAt: "2026-07-02T00:00:00Z" },
  }),
  null,
);

const forwardSales = Array.from({ length: 40 }, (_, card) => {
  const id = `heldout-${String(card).padStart(2, "0")}`,
    base = 100 + card;
  return [
    ...[9, 10].flatMap((grade) =>
      [0.99, 1, 1.01, 0.99, 1, 1.01].map((n, i) =>
        sale(
          id,
          grade,
          base * (grade === 10 ? 2 : 1) * n,
          `fit-${id}-${grade}-${i}`,
        ),
      ),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      sale(
        id,
        9,
        base * (0.9 + i * 0.04),
        `cal-${id}-${i}`,
        "2026-07-15",
        "2026-07-16T00:00:00Z",
      ),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      sale(
        id,
        9,
        base * (0.91 + i * 0.035),
        `test-${id}-${i}`,
        "2026-08-15",
        "2026-08-16T00:00:00Z",
      ),
    ),
  ];
}).flat();
const dates = {
  fitCutoff: cutoff,
  calibrationEnd: "2026-08-01T00:00:00Z",
  testEnd: "2026-09-01T00:00:00Z",
  asOf: "2026-09-05T00:00:00Z",
};
const started = performance.now();
const report = evaluateGradeModel(forwardSales, dates);
assert.equal(report.cohorts.length, 1);
assert.equal(report.cohorts[0].testCards, 40);
assert.equal(report.cohorts[0].transactions, 240);
assert.equal(
  report.cohorts[0].enabled,
  false,
  "Equal performance to ratio baseline cannot enable the model",
);
assert.ok(report.cohorts[0].reasons.includes("not-better-than-ratio-baseline"));
assert.ok(
  report.scores.some(
    (s) =>
      s.method === "fitted" &&
      s.scenario === "hidden-grade" &&
      s.predicted !== null &&
      s.low !== null,
  ),
);
const sourceById = new Map(forwardSales.map((s) => [s.eventId, s]));
for (const fold of report.lineage)
  for (const id of fold.trainingEvents) {
    const used = sourceById.get(id)!;
    assert.ok(
      !fold.heldOutCards.includes(used.cardId) &&
        !fold.calibrationCards.includes(used.cardId),
    );
    assert.ok(
      used.capturedAt <= dates.fitCutoff &&
        used.soldOn < dates.fitCutoff.slice(0, 10),
    );
  }
const changed = evaluateGradeModel(
  [
    ...forwardSales,
    {
      ...forwardSales[0],
      eventId: "future-outcome",
      amount: 90000,
      capturedAt: "2026-10-01T00:00:00Z",
    },
  ],
  dates,
);
assert.deepEqual(changed.scores, report.scores);
assert.deepEqual(changed.cohorts, report.cohorts);
assert.throws(() =>
  evaluateGradeModel(forwardSales, { ...dates, calibrationEnd: cutoff }),
);
assert.throws(() =>
  evaluateGradeModel(forwardSales, {
    ...dates,
    calibrationEnd: "2026-08-01T12:00:00Z",
  }),
);
const diagnostic = reproduceGradeDiagnostic();
assert.equal(diagnostic.isForwardValidation, false);
assert.ok(
  Math.abs(diagnostic.meanAbsolutePercentageError - 24.624450894080514) < 1e-9,
);
console.log(
  `PASS deterministic cohort grade effects, direct-evidence shrinkage, no grader/label equivalence, duplicate/future-data barriers, held-out calibrated evaluation and 24.6% historical diagnostic (${Math.round(performance.now() - started)}ms for 40-card fixture)`,
);
