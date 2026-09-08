import { forecastEvaluationsRepository } from "~/core/db";
import {
  FORECAST_EVALUATION_POLICY,
  evaluateForecastEvidence,
  type ForecastEvaluationEvidence,
  type ForecastEvaluationReport,
} from "~/features/pricing/domain/forecastEvaluation";
import { createVersionedCache } from "./versionedCache";

export interface ForecastEvaluationSource {
  findEvidenceVersion(sellerKey: string): Promise<string>;
  findMaterialEvidenceVersion(sellerKey: string): Promise<string>;
  findEvidence(sellerKey: string): Promise<ForecastEvaluationEvidence>;
  save(report: ForecastEvaluationReport): Promise<{ id: string; created: boolean }>;
}

const reports = createVersionedCache<ForecastEvaluationReport>("Forecast evaluation");

/** Evaluates and persists one result for each frozen source-evidence version. */
export async function loadForecastGrading(
  sellerKey: string,
  source: ForecastEvaluationSource = forecastEvaluationsRepository,
): Promise<ForecastEvaluationReport | null> {
  const seller = sellerKey.trim();
  if (!seller) return null;
  const version = await source.findEvidenceVersion(seller);
  const report = await reports.read(seller, "", version, async () => {
    const report = {
      ...evaluateForecastEvidence(await source.findEvidence(seller)),
      materialEvidenceVersion: await source.findMaterialEvidenceVersion(seller),
    };
    const saved = await source.save(report);
    return { ...report, evaluationId: saved.id };
  });
  return Date.now() - Date.parse(report.evaluatedAt) >
    FORECAST_EVALUATION_POLICY.maximumEvidenceAgeDays * 86_400_000
    ? {
        ...report,
        status: "abstained",
        statusReasons: ["evidence_is_stale"],
        correction: report.correction
          ? { ...report.correction, eligible: false, reasons: ["evidence_is_stale"] }
          : null,
      }
    : report;
}
