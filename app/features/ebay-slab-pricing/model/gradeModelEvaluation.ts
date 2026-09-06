import policy from "./gradeModelPolicy.json";
import {
  availableGradeSales,
  fitGradeModel,
  gradeCohortKey,
  median,
  predictGrade,
  type GradePrediction,
  type GradeSale,
} from "./gradeModel";

const METHODS = ["direct", "ratio", "fitted"] as const;
const SCENARIOS = ["observed-grade", "hidden-grade"] as const;
export type GradeEvaluationDates = {
  fitCutoff: string;
  calibrationEnd: string;
  testEnd: string;
  asOf: string;
};
type Scenario = (typeof SCENARIOS)[number];
export type GradeScore = {
  cohort: string;
  fold: number;
  cardId: string;
  grade: number;
  eventId: string;
  scenario: Scenario;
  method: GradePrediction["method"];
  actual: number;
  predicted: number | null;
  low: number | null;
  high: number | null;
  calibrationCount: number;
};
function summary(rows: GradeScore[]) {
  const predicted = rows.filter((r) => r.predicted !== null);
  const intervals = predicted.filter((r) => r.low !== null && r.high !== null);
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    opportunities: rows.length,
    predicted: predicted.length,
    abstained: rows.length - predicted.length,
    coverage: rows.length ? predicted.length / rows.length : 0,
    meanAbsoluteLogError: mean(
      predicted.map((r) => Math.abs(Math.log(r.predicted! / r.actual))),
    ),
    medianRelativeError: median(
      predicted.map((r) => Math.abs(r.predicted! / r.actual - 1)),
    ),
    calibratedIntervals: intervals.length,
    intervalCoverage: mean(
      intervals.map((r) => Number(r.actual >= r.low! && r.actual <= r.high!)),
    ),
    medianIntervalRatio: median(intervals.map((r) => r.high! / r.low!)),
    minimumCalibrationCount: predicted.length
      ? Math.min(...predicted.map((r) => r.calibrationCount))
      : 0,
  };
}
function calibratedRadius(errors: number[]) {
  if (errors.length < policy.minimumCalibrationTransactions) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  return (
    sorted[
      Math.ceil((sorted.length + 1) * policy.intervalTargetCoverage) - 1
    ] ?? null
  );
}
function pairedError(
  rows: GradeScore[],
  baseline: "ratio" | "direct",
  scenario: Scenario,
) {
  const reference = new Map(
    rows
      .filter(
        (r) =>
          r.method === baseline &&
          r.scenario === scenario &&
          r.predicted !== null,
      )
      .map((r) => [r.eventId, r]),
  );
  const pairs = rows.filter(
    (r) =>
      r.method === "fitted" &&
      r.scenario === scenario &&
      r.predicted !== null &&
      reference.has(r.eventId),
  );
  const model = pairs.reduce(
    (sum, r) => sum + Math.abs(Math.log(r.predicted! / r.actual)),
    0,
  );
  const base = pairs.reduce(
    (sum, r) =>
      sum + Math.abs(Math.log(reference.get(r.eventId)!.predicted! / r.actual)),
    0,
  );
  return {
    pairs: pairs.length,
    modelMeanLogError: pairs.length ? model / pairs.length : null,
    baselineMeanLogError: pairs.length ? base / pairs.length : null,
    improvement:
      base > 0 ? 1 - model / base : model === 0 && pairs.length ? 0 : null,
  };
}
export function evaluateGradeModel(
  sales: readonly GradeSale[],
  dates: GradeEvaluationDates,
) {
  const times = [
    dates.fitCutoff,
    dates.calibrationEnd,
    dates.testEnd,
    dates.asOf,
  ].map(Date.parse);
  if (
    times.some((t) => !Number.isFinite(t)) ||
    [dates.fitCutoff, dates.calibrationEnd, dates.testEnd].some(
      (date) => !/T00:00:00(?:\.000)?Z$/.test(date),
    ) ||
    !(times[0] < times[1] && times[1] < times[2] && times[2] <= times[3])
  )
    throw new Error(
      "Use ordered fitting, calibration, test and capture cutoffs.",
    );
  const truth = availableGradeSales(sales, dates.asOf);
  const fittingHistory = availableGradeSales(sales, dates.fitCutoff);
  const testHistory = availableGradeSales(sales, dates.calibrationEnd);
  const histories = new Map<string, GradeSale[]>();
  for (const [cutoff, available] of [
    [dates.fitCutoff, fittingHistory],
    [dates.calibrationEnd, testHistory],
  ] as const) {
    for (const sale of available) {
      const key = JSON.stringify([
        cutoff,
        gradeCohortKey(sale.cohort),
        sale.cardId,
      ]);
      const rows = histories.get(key) ?? [];
      rows.push(sale);
      histories.set(key, rows);
    }
  }
  const cohortKeys = [
    ...new Set(truth.map((s) => gradeCohortKey(s.cohort)!)),
  ].sort();
  const scores: GradeScore[] = [];
  const lineage: Array<{
    cohort: string;
    fold: number;
    trainingRevisions: string[];
    trainingEvents: string[];
    heldOutCards: string[];
    calibrationCards: string[];
  }> = [];
  for (const cohort of cohortKeys) {
    const rows = truth.filter((s) => gradeCohortKey(s.cohort) === cohort);
    const cards = [...new Set(rows.map((s) => s.cardId))].sort();
    // Each fold holds out distinct test and calibration cards, so even hidden-grade calibration cannot leak the card into the fitted prior.
    for (let fold = 0; fold < 5; fold++) {
      const heldOutCards = cards.filter((_, i) => i % 5 === fold);
      const calibrationCards = cards.filter((_, i) => i % 5 === (fold + 1) % 5);
      const model = fitGradeModel(
        fittingHistory.filter((s) => gradeCohortKey(s.cohort) === cohort),
        rows[0].cohort,
        dates.fitCutoff,
        [...heldOutCards, ...calibrationCards],
      );
      lineage.push({
        cohort,
        fold,
        trainingRevisions: model?.lineage.revisions ?? [],
        trainingEvents: model?.lineage.eventIds ?? [],
        heldOutCards,
        calibrationCards,
      });
      const calibration = rows.filter(
        (s) =>
          calibrationCards.includes(s.cardId) &&
          s.soldOn >= dates.fitCutoff.slice(0, 10) &&
          s.soldOn < dates.calibrationEnd.slice(0, 10) &&
          Date.parse(s.capturedAt) <= times[1],
      );
      const testing = rows.filter(
        (s) =>
          heldOutCards.includes(s.cardId) &&
          s.soldOn >= dates.calibrationEnd.slice(0, 10) &&
          s.soldOn < dates.testEnd.slice(0, 10),
      );
      for (const method of METHODS)
        for (const scenario of SCENARIOS) {
          const predictions = new Map<string, GradePrediction | null>();
          const predict = (sale: GradeSale, cutoff: string) => {
            const key = JSON.stringify([cutoff, sale.cardId, sale.grade]);
            if (!predictions.has(key)) {
              const history =
                histories.get(JSON.stringify([cutoff, cohort, sale.cardId])) ??
                [];
              predictions.set(
                key,
                predictGrade({
                  method,
                  model,
                  history:
                    scenario === "hidden-grade"
                      ? history.filter((s) => s.grade !== sale.grade)
                      : history,
                  cardId: sale.cardId,
                  cohort: sale.cohort,
                  grade: sale.grade,
                  cutoff,
                }),
              );
            }
            return predictions.get(key)!;
          };
          const errors = calibration.flatMap((sale) => {
            const prediction = predict(sale, dates.fitCutoff);
            return prediction
              ? [Math.abs(Math.log(prediction.midpoint / sale.amount))]
              : [];
          });
          const radius = calibratedRadius(errors);
          for (const sale of testing) {
            const prediction = predict(sale, dates.calibrationEnd);
            scores.push({
              cohort,
              fold,
              cardId: sale.cardId,
              grade: sale.grade,
              eventId: sale.eventId!,
              scenario,
              method,
              actual: sale.amount,
              predicted: prediction?.midpoint ?? null,
              low:
                prediction && radius !== null
                  ? prediction.midpoint * Math.exp(-radius)
                  : null,
              high:
                prediction && radius !== null
                  ? prediction.midpoint * Math.exp(radius)
                  : null,
              calibrationCount: errors.length,
            });
          }
        }
    }
  }
  const cohorts = cohortKeys.map((cohort) => {
    const rows = scores.filter((r) => r.cohort === cohort);
    const metrics = SCENARIOS.flatMap((scenario) =>
      METHODS.map((method) => ({
        scenario,
        method,
        ...summary(
          rows.filter((r) => r.scenario === scenario && r.method === method),
        ),
      })),
    );
    const sparse = metrics.find(
      (m) => m.scenario === "hidden-grade" && m.method === "fitted",
    )!;
    const dense = metrics.find(
      (m) => m.scenario === "observed-grade" && m.method === "fitted",
    )!;
    const ratio = pairedError(rows, "ratio", "hidden-grade"),
      direct = pairedError(rows, "direct", "observed-grade");
    const testCards = new Set(rows.map((r) => r.cardId)).size,
      transactions = new Set(rows.map((r) => r.eventId)).size;
    const reasons: string[] = [];
    if (testCards < policy.minimumTestCards)
      reasons.push("insufficient-test-cards");
    if (transactions < policy.minimumTestTransactions)
      reasons.push("insufficient-test-transactions");
    if (sparse.coverage < policy.minimumSparseCoverage)
      reasons.push("insufficient-sparse-coverage");
    if (
      ratio.pairs < policy.minimumPairedComparisons ||
      ratio.improvement === null ||
      ratio.improvement < policy.minimumLogErrorImprovementOverRatio
    )
      reasons.push("not-better-than-ratio-baseline");
    if (
      direct.pairs < policy.minimumPairedComparisons ||
      direct.improvement === null ||
      direct.improvement < -policy.maximumLogErrorRegressionAgainstDirect
    )
      reasons.push("direct-baseline-regression-or-insufficient-comparisons");
    for (const metric of [sparse, dense]) {
      if (
        metric.medianRelativeError === null ||
        metric.medianRelativeError > policy.maximumMedianRelativeError
      )
        reasons.push(`${metric.scenario}-relative-error`);
      if (
        metric.minimumCalibrationCount <
          policy.minimumCalibrationTransactions ||
        metric.calibratedIntervals !== metric.predicted ||
        metric.intervalCoverage === null ||
        metric.intervalCoverage < policy.minimumIntervalCoverage ||
        metric.intervalCoverage > policy.maximumIntervalCoverage ||
        metric.medianIntervalRatio === null ||
        metric.medianIntervalRatio > policy.maximumMedianIntervalRatio
      )
        reasons.push(`${metric.scenario}-uncalibrated-uncertainty`);
    }
    return {
      cohort,
      enabled: reasons.length === 0,
      reasons,
      testCards,
      transactions,
      metrics,
      paired: { ratio, direct },
      byGrade: [...new Set(rows.map((r) => r.grade))]
        .sort((a, b) => a - b)
        .map((grade) => ({
          grade,
          ...summary(
            rows.filter(
              (r) =>
                r.grade === grade &&
                r.method === "fitted" &&
                r.scenario === "hidden-grade",
            ),
          ),
        })),
    };
  });
  return {
    version: "grade-forward-evaluation-v1",
    policyVersion: policy.version,
    dates,
    inputObservations: sales.length,
    eligibleUniqueEvents: truth.length,
    cohorts,
    lineage,
    scores,
  };
}
