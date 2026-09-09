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
  findEvidenceSnapshot?(sellerKey: string): Promise<{
    evidenceVersion: string;
    materialEvidenceVersion: string;
    evidence: ForecastEvaluationEvidence;
  }>;
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
    const snapshot = source.findEvidenceSnapshot
      ? await source.findEvidenceSnapshot(seller)
      : await (async () => {
          const materialBefore = await source.findMaterialEvidenceVersion(seller);
          const evidence = await source.findEvidence(seller);
          const [evidenceAfter, materialAfter] = await Promise.all([
            source.findEvidenceVersion(seller),
            source.findMaterialEvidenceVersion(seller),
          ]);
          if (evidenceAfter !== version || materialAfter !== materialBefore) {
            throw new Error("Forecast evidence changed while its snapshot was being read.");
          }
          return {
            evidenceVersion: evidenceAfter,
            materialEvidenceVersion: materialAfter,
            evidence,
          };
        })();
    if (snapshot.evidenceVersion !== version) {
      throw new Error("Forecast evidence changed before its snapshot was frozen.");
    }
    const report = {
      ...evaluateForecastEvidence(snapshot.evidence),
      materialEvidenceVersion: snapshot.materialEvidenceVersion,
    };
    if ([report.evaluatedAt, report.fitCutoff, report.validationCutoff]
      .some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0)) {
      throw new Error("Forecast validation evidence dates are unavailable.");
    }
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
