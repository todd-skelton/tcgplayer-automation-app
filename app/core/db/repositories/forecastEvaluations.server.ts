import { createHash } from "node:crypto";
import { PRICING_MODEL_VERSION, type ForecastCorrection } from "~/core/types/pricingPolicy";
import {
  FORECAST_EVALUATION_POLICY,
  type FifoSettlementEvidence,
  type ForecastEvaluationEvidence,
  type ForecastEvaluationReport,
  type InventoryExposureObservation,
  type PublicationForecastSpell,
  type SellerSkuOrderRevision,
} from "~/features/pricing/domain/forecastEvaluation";
import { asJson, query, queryOne, withTransaction, type Queryable } from "../database.server";

const EVIDENCE_LIMIT = 50_000;
const publicationSpellEvidenceCte = `WITH latest_revisions AS MATERIALIZED (
  SELECT DISTINCT ON (revision.order_id) revision.*
  FROM seller_order_revisions revision
  JOIN seller_orders orders ON orders.id=revision.order_id
  WHERE orders.seller_key=$1 AND revision.observed_at<=$2
  ORDER BY revision.order_id,revision.revision_number DESC
), verified_sales AS MATERIALIZED (
  SELECT DISTINCT revision.order_time,(line->>'skuId')::int AS sku
  FROM latest_revisions revision
  CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) line
  WHERE revision.order_time IS NOT NULL AND revision.order_time_evidence='detail_canonical'
    AND revision.lifecycle NOT IN ('canceled','unknown')
    AND line->>'skuId'~'^[1-9][0-9]{0,9}$'
    AND (line->>'skuId')::bigint BETWEEN 1 AND 2147483647
), sequenced AS (
  SELECT item.id::text AS "publicationItemId",publication.seller_key AS "sellerKey",
    item.sku,item.product_line AS "productLine",catalog.product_line_id AS "productLineId",
    item.published_at AS "publishedAt",
    LEAD(item.published_at) OVER (PARTITION BY publication.seller_key,item.sku
      ORDER BY item.published_at,item.id) AS "nextPublishedAt",
    item.desired_price::float8 AS "desiredPrice",
    GREATEST(ABS(item.quantity_delta),COALESCE(item.desired_absolute_quantity,0),
      COALESCE(item.observed_quantity,0),1)::int AS quantity,
    item.forecast_evidence AS "forecastEvidence",
    item.forecast_evidence_provenance AS "forecastEvidenceProvenance"
  FROM inventory_publication_items item
  JOIN inventory_publications publication ON publication.id=item.publication_id
  LEFT JOIN skus catalog ON catalog.sku=item.sku
  WHERE publication.seller_key=$1 AND item.status='published'
), classified AS (
  SELECT sequenced.*,
    ("publishedAt" IS NULL OR "nextPublishedAt" IS NULL
      OR "nextPublishedAt">="publishedAt"+($3*INTERVAL '1 day')
      OR COUNT(sale.sku)>0
    ) AS relevant
  FROM sequenced
  LEFT JOIN verified_sales sale ON sale.sku=sequenced.sku
    AND sale.order_time>="publishedAt"
    AND sale.order_time<LEAST("nextPublishedAt","publishedAt"+($3*INTERVAL '1 day'))
  WHERE "forecastEvidence" IS NOT NULL
  GROUP BY sequenced."publicationItemId",sequenced."sellerKey",sequenced.sku,
    sequenced."productLine",sequenced."productLineId",sequenced."publishedAt",
    sequenced."nextPublishedAt",sequenced."desiredPrice",sequenced.quantity,
    sequenced."forecastEvidence",sequenced."forecastEvidenceProvenance"
)`;

interface EvaluationRow {
  id: string;
  report: ForecastEvaluationReport;
}

function stableKey(report: ForecastEvaluationReport): string {
  return createHash("sha256")
    .update(
      `${report.policy.version}|${report.sellerKey}|${report.evidenceFingerprint}|${report.materialEvidenceVersion ?? "missing-material-version"}`,
    )
    .digest("hex");
}

export const forecastEvaluationsRepository = {
  async findMaterialEvidenceVersion(sellerKey: string, executor?: Queryable): Promise<string> {
    const row = await queryOne<{
      publicationAt: Date | null;
      orderRevisionAt: Date | null;
      observationAt: Date | null;
      fifoRevisionAt: Date | null;
    }>(
      `SELECT
        (SELECT MAX(item.updated_at) FROM inventory_publication_items item
          JOIN inventory_publications publication ON publication.id=item.publication_id
          WHERE publication.seller_key=$1 AND item.status='published') AS "publicationAt",
        (SELECT MAX(revision.observed_at) FROM seller_order_revisions revision
          JOIN seller_orders orders ON orders.id=revision.order_id WHERE orders.seller_key=$1) AS "orderRevisionAt",
        (SELECT MAX(cutoff_at) FROM inventory_complete_observations
          WHERE seller_key=$1 AND status='complete') AS "observationAt",
        (SELECT MAX(revision.recorded_at) FROM inventory_fifo_revisions revision
          JOIN inventory_fifo_lines line ON line.id=revision.line_id WHERE line.seller_key=$1) AS "fifoRevisionAt"`,
      [sellerKey.trim()], executor,
    );
    return Object.values(row ?? {}).map((value) => value instanceof Date ? value.toISOString() : "").join("|");
  },

  async findEvidenceVersion(sellerKey: string, executor?: Queryable): Promise<string> {
    const [material, run] = await Promise.all([
      this.findMaterialEvidenceVersion(sellerKey, executor),
      queryOne<{ runAt: Date | null }>(
        `SELECT MAX(updated_at) AS "runAt" FROM seller_order_sync_runs WHERE seller_key=$1`,
        [sellerKey.trim()], executor,
      ),
    ]);
    return `${material}|${run?.runAt?.toISOString() ?? ""}`;
  },

  async findEvidence(sellerKey: string, executor?: Queryable): Promise<ForecastEvaluationEvidence> {
    const seller = sellerKey.trim();
    if (!seller) throw new Error("Seller key is required.");
    const run = await queryOne<{
      id: string; status: "complete" | "incomplete" | "running";
      observedFrom: Date | null; finishedAt: Date | null; updatedAt: Date; gaps: Array<{ orderNumber?: string }>;
    }>(
      `SELECT id::text AS id,status,observed_from AS "observedFrom",
        finished_at AS "finishedAt",updated_at AS "updatedAt",gaps
       FROM seller_order_sync_runs WHERE seller_key=$1 AND source='tcgplayer_api'
       ORDER BY started_at DESC,id DESC LIMIT 1`, [seller], executor,
    );
    const evaluatedAt = run?.finishedAt ?? run?.updatedAt ?? new Date(0);
    const completedRuns = run?.status === "complete"
      ? await query<{ observedFrom: Date | null; finishedAt: Date }>(
          `SELECT observed_from AS "observedFrom",finished_at AS "finishedAt"
           FROM seller_order_sync_runs
           WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete'
             AND finished_at IS NOT NULL AND gaps='[]'::jsonb
           ORDER BY finished_at DESC,id DESC`,
          [seller], executor,
        )
      : [];
    let coveredFrom = run?.observedFrom ?? null;
    for (const completed of completedRuns) {
      if (!completed.observedFrom || !coveredFrom) continue;
      // Retained rolling scans extend coverage only when their observed
      // intervals overlap. A missing bridge leaves the later boundary intact.
      if (completed.finishedAt >= coveredFrom && completed.observedFrom < coveredFrom) {
        coveredFrom = completed.observedFrom;
      }
    }
    const retainedCoverage = run?.status === "complete"
      ? await queryOne<{ coveredFrom: Date | null; cutoffAt: Date | null }>(
          `SELECT (report_json->'provenance'->>'coveredFrom')::timestamptz AS "coveredFrom",
            (report_json->'provenance'->>'cutoffAt')::timestamptz AS "cutoffAt"
           FROM forecast_evaluations WHERE seller_key=$1
           ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
          [seller], executor,
        )
      : null;
    if (
      coveredFrom &&
      retainedCoverage?.coveredFrom &&
      retainedCoverage.cutoffAt &&
      retainedCoverage.cutoffAt >= coveredFrom &&
      retainedCoverage.coveredFrom < coveredFrom
    ) {
      // Evaluations retain the union boundary after high-frequency scan rows
      // age out, but only while each newly observed interval overlaps it.
      coveredFrom = retainedCoverage.coveredFrom;
    }
    const from = new Date(evaluatedAt.getTime() - FORECAST_EVALUATION_POLICY.lookbackDays * 86_400_000);
    const [omitted, spells] = await Promise.all([
      queryOne<{
        missingForecastSpells: number; missingForecastQuantity: number;
        repricedSpells: number; repricedQuantity: number;
      }>(
        `${publicationSpellEvidenceCte}
         SELECT
          (SELECT COUNT(*)::int FROM inventory_publication_items item
            JOIN inventory_publications publication ON publication.id=item.publication_id
            WHERE publication.seller_key=$1 AND item.status='published'
              AND (item.published_at IS NULL OR item.published_at>=$4)
              AND item.forecast_evidence IS NULL) AS "missingForecastSpells",
          (SELECT COALESCE(SUM(GREATEST(ABS(item.quantity_delta),COALESCE(item.desired_absolute_quantity,0),
            COALESCE(item.observed_quantity,0),1)),0)::int FROM inventory_publication_items item
            JOIN inventory_publications publication ON publication.id=item.publication_id
            WHERE publication.seller_key=$1 AND item.status='published'
              AND (item.published_at IS NULL OR item.published_at>=$4)
              AND item.forecast_evidence IS NULL) AS "missingForecastQuantity",
          COUNT(*) FILTER (WHERE NOT relevant AND "publishedAt">=$4)::int AS "repricedSpells",
          COALESCE(SUM(quantity) FILTER (WHERE NOT relevant AND "publishedAt">=$4),0)::int AS "repricedQuantity"
         FROM classified`,
        [seller, evaluatedAt, FORECAST_EVALUATION_POLICY.horizonDays, from], executor,
      ),
      query<Omit<PublicationForecastSpell, "publishedAt" | "nextPublishedAt"> & { publishedAt: Date | null; nextPublishedAt: Date | null }>(
        `${publicationSpellEvidenceCte}
         SELECT * FROM classified
         WHERE relevant AND ("publishedAt" IS NULL OR "publishedAt">=$4)
         ORDER BY "publishedAt" NULLS LAST,"publicationItemId" LIMIT $5`,
        [seller, evaluatedAt, FORECAST_EVALUATION_POLICY.horizonDays, from, EVIDENCE_LIMIT], executor,
      ),
    ]);
    const normalizedSpells: PublicationForecastSpell[] = spells.map((spell) => ({
      ...spell,
      publishedAt: spell.publishedAt instanceof Date ? spell.publishedAt.toISOString() : spell.publishedAt,
      nextPublishedAt: spell.nextPublishedAt instanceof Date ? spell.nextPublishedAt.toISOString() : spell.nextPublishedAt,
    }));
    const revisions = await query<Omit<SellerSkuOrderRevision, "observedAt" | "orderTime"> & { observedAt: Date; orderTime: Date }>(
      `WITH latest AS (
        SELECT DISTINCT ON (revision.order_id) revision.*,orders.order_number
        FROM seller_order_revisions revision
        JOIN seller_orders orders ON orders.id=revision.order_id
        WHERE orders.seller_key=$1 AND revision.observed_at<=$2
        ORDER BY revision.order_id,revision.revision_number DESC
      )
      SELECT latest.order_id::text AS "orderId",latest.order_number AS "orderNumber",
        latest.revision_number AS revision,latest.observed_at AS "observedAt",
        latest.order_time AS "orderTime",latest.order_time_evidence AS "orderTimeEvidence",
        latest.lifecycle,latest.source,(line->>'skuId')::int AS sku,
        SUM((line->>'quantity')::int)::int AS quantity
      FROM latest CROSS JOIN LATERAL jsonb_array_elements(latest.line_evidence) line
      WHERE latest.order_time IS NOT NULL AND line->>'skuId'~'^[1-9][0-9]{0,9}$'
        AND (line->>'skuId')::bigint BETWEEN 1 AND 2147483647
      GROUP BY latest.order_id,latest.order_number,latest.revision_number,latest.observed_at,
        latest.order_time,latest.order_time_evidence,latest.lifecycle,latest.source,(line->>'skuId')::int
      ORDER BY latest.order_time,latest.order_id LIMIT $3`,
      [seller, evaluatedAt, EVIDENCE_LIMIT], executor,
    );
    const activeOrdersBySku = new Map<number, Array<(typeof revisions)[number]>>();
    for (const revision of revisions) {
      if (revision.lifecycle === "canceled" || revision.lifecycle === "unknown") continue;
      activeOrdersBySku.set(revision.sku, [...(activeOrdersBySku.get(revision.sku) ?? []), revision]);
    }
    const exposureWindows = new Map<number, { sku: number; fromAt: string; throughAt: string }>();
    const removalWindows = new Map<number, { sku: number; fromAt: string; throughAt: string }>();
    for (const spell of normalizedSpells) {
      if (!spell.publishedAt) continue;
      const publishedAt = Date.parse(spell.publishedAt);
      const throughAt = publishedAt + FORECAST_EVALUATION_POLICY.horizonDays * 86_400_000;
      const sale = (activeOrdersBySku.get(spell.sku) ?? []).find((order) => {
            const orderTime = order.orderTime.getTime();
            return orderTime >= publishedAt && orderTime < Math.min(
              throughAt,
              spell.nextPublishedAt ? Date.parse(spell.nextPublishedAt) : Infinity,
            );
          });
      if (sale) {
        const previous = removalWindows.get(spell.sku);
        removalWindows.set(spell.sku, {
          sku: spell.sku,
          fromAt: previous && Date.parse(previous.fromAt) < publishedAt
            ? previous.fromAt
            : new Date(publishedAt).toISOString(),
          throughAt: previous && Date.parse(previous.throughAt) > sale.orderTime.getTime()
            ? previous.throughAt
            : sale.orderTime.toISOString(),
        });
        continue;
      }
      if (throughAt > evaluatedAt.getTime() ||
          (spell.nextPublishedAt && Date.parse(spell.nextPublishedAt) < throughAt)) continue;
      const previous = exposureWindows.get(spell.sku);
      exposureWindows.set(spell.sku, {
        sku: spell.sku,
        fromAt: previous && Date.parse(previous.fromAt) < publishedAt ? previous.fromAt : new Date(publishedAt).toISOString(),
        throughAt: previous && Date.parse(previous.throughAt) > throughAt
          ? previous.throughAt
          : new Date(throughAt + FORECAST_EVALUATION_POLICY.maximumExposureGapDays * 86_400_000).toISOString(),
      });
    }
    const windows = [...exposureWindows.values()];
    const continuousExposure = windows.length === 0 ? [] : await query<Omit<InventoryExposureObservation, "observedAt"> & { observedAt: Date }>(
      `WITH windows AS (
        SELECT * FROM jsonb_to_recordset($4::jsonb)
          AS exposure_window(sku int,"fromAt" timestamptz,"throughAt" timestamptz)
       )
       SELECT observation.id::text AS "observationId",item.sku,
        observation.cutoff_at AS "observedAt",item.quantity
       FROM windows
       JOIN inventory_complete_observation_items item ON item.sku=windows.sku
       JOIN inventory_complete_observations observation ON observation.id=item.observation_id
         AND observation.cutoff_at BETWEEN windows."fromAt" AND windows."throughAt"
       WHERE observation.seller_key=$1 AND observation.status='complete'
         AND observation.cutoff_at BETWEEN $2 AND $3
       ORDER BY observation.cutoff_at,observation.id,item.sku LIMIT $5`,
      [seller, from, evaluatedAt, asJson(windows), EVIDENCE_LIMIT], executor,
    );
    const removalWindowValues = [...removalWindows.values()];
    const removalExposure = removalWindowValues.length === 0 ? [] : await query<Omit<InventoryExposureObservation, "observedAt"> & { observedAt: Date }>(
      `WITH windows AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb)
          AS exposure_window(sku int,"fromAt" timestamptz,"throughAt" timestamptz)
       )
       SELECT observation.id::text AS "observationId",item.sku,
        observation.cutoff_at AS "observedAt",item.quantity
       FROM windows
       JOIN inventory_complete_observation_items item ON item.sku=windows.sku AND item.quantity=0
       JOIN inventory_complete_observations observation ON observation.id=item.observation_id
         AND observation.cutoff_at BETWEEN windows."fromAt" AND windows."throughAt"
       WHERE observation.seller_key=$1 AND observation.status='complete'
       ORDER BY observation.cutoff_at,observation.id,item.sku LIMIT $3`,
      [seller, asJson(removalWindowValues), EVIDENCE_LIMIT], executor,
    );
    const exposure = [...continuousExposure, ...removalExposure];
    const skus = [...new Set(normalizedSpells.map((spell) => spell.sku))];
    const fifo = skus.length === 0 ? [] : await query<Omit<FifoSettlementEvidence, "latestRecordedAt"> & { latestRecordedAt: Date | null }>(
      `WITH requested AS (SELECT unnest($2::int[]) AS sku),
       latest AS (
        SELECT DISTINCT ON (revision.line_id) line.sku,revision.id::text,revision.state,
          revision.recorded_at
        FROM inventory_fifo_revisions revision
        JOIN inventory_fifo_lines line ON line.id=revision.line_id
        WHERE line.seller_key=$1 AND line.sku=ANY($2::int[]) AND revision.recorded_at<=$3
        ORDER BY revision.line_id,revision.revision_number DESC
       )
       SELECT requested.sku,
        CASE WHEN BOOL_OR(replay.status='held') OR BOOL_OR(latest.state='held') THEN 'held'
          WHEN BOOL_OR(replay.status IN ('pending','processing')) OR BOOL_OR(latest.state IN ('pending','unsupported')) THEN 'pending'
          ELSE 'settled' END AS state,
        COALESCE(array_agg(latest.id ORDER BY latest.id) FILTER (WHERE latest.id IS NOT NULL),'{}') AS "revisionIds",
        MAX(latest.recorded_at) AS "latestRecordedAt"
       FROM requested LEFT JOIN latest ON latest.sku=requested.sku
       LEFT JOIN inventory_fifo_replay_queue replay ON replay.seller_key=$1
         AND replay.sku=requested.sku AND replay.affected_from<=$3
       GROUP BY requested.sku ORDER BY requested.sku`,
      [seller, skus, evaluatedAt], executor,
    );
    const sourceLimited = spells.length >= EVIDENCE_LIMIT || revisions.length >= EVIDENCE_LIMIT || exposure.length >= EVIDENCE_LIMIT;
    return {
      sellerKey: seller,
      evaluatedAt: evaluatedAt.toISOString(),
      orderHistory: {
        runId: run?.id ?? null,
        status: sourceLimited ? "incomplete" : (run?.status ?? "not_started"),
        coveredFrom: coveredFrom?.toISOString() ?? null,
        cutoffAt: run?.finishedAt?.toISOString() ?? null,
        gaps: sourceLimited ? ["source_limit"] : (run?.gaps ?? []).map((gap) => gap.orderNumber ?? "unknown_gap"),
      },
      spells: normalizedSpells,
      orderRevisions: revisions.map((revision) => ({ ...revision, observedAt: revision.observedAt.toISOString(), orderTime: revision.orderTime.toISOString() })),
      exposure: exposure.map((observation) => ({ ...observation, observedAt: observation.observedAt.toISOString() })),
      fifo: fifo.map((value) => ({ ...value, latestRecordedAt: value.latestRecordedAt?.toISOString() ?? null })),
      sourceExclusions: {
        ...(omitted?.missingForecastSpells
          ? { missing_forecast: { spells: omitted.missingForecastSpells, quantity: omitted.missingForecastQuantity } }
          : {}),
        ...(omitted?.repricedSpells
          ? { repriced_before_horizon: { spells: omitted.repricedSpells, quantity: omitted.repricedQuantity } }
          : {}),
      },
    };
  },

  async save(report: ForecastEvaluationReport): Promise<{ id: string; created: boolean }> {
    return withTransaction(async (db) => {
      const key = stableKey(report);
      const existing = await queryOne<{ id: string }>(
        `SELECT id::text AS id FROM forecast_evaluations WHERE evaluation_key=$1`, [key], db,
      );
      if (existing) return { id: existing.id, created: false };
      const previous = await queryOne<{ id: string }>(
        `SELECT id::text AS id FROM forecast_evaluations WHERE seller_key=$1
         ORDER BY evaluated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [report.sellerKey], db,
      );
      const inserted = await queryOne<{ id: string }>(
        `INSERT INTO forecast_evaluations
          (evaluation_key,seller_key,target_version,evidence_fingerprint,evaluated_at,
           fit_cutoff,validation_cutoff,status,report_json,supersedes_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id::text AS id`,
        [key, report.sellerKey, report.policy.version, report.evidenceFingerprint,
          report.evaluatedAt, report.fitCutoff, report.validationCutoff, report.status,
          asJson(report), previous?.id ?? null], db,
      );
      if (!inserted) throw new Error("Forecast evaluation was not saved.");
      if (previous) {
        const active = await queryOne<{ correction: Record<string, unknown> | null }>(
          `SELECT pricing_json->'forecastCorrection' AS correction FROM pricing_config
           WHERE config_key='default' FOR UPDATE`, [], db,
        );
        if (
          active?.correction &&
          String(active.correction.evaluationId ?? "") === previous.id
        ) {
          const version = String(active.correction.version ?? "unknown");
          const sameCorrection = report.status === "eligible" && report.correction?.eligible &&
            report.correction.version === version &&
            report.correction.sourceModelVersion === `curve:${String(active.correction.sourceModelVersion ?? "")}` &&
            report.correction.medianDaysMultiplier === active.correction.medianDaysMultiplier;
          if (sameCorrection) {
            const reconfirmed = {
              version: report.correction!.version,
              sourceModelVersion: String(active.correction.sourceModelVersion),
              medianDaysMultiplier: report.correction!.medianDaysMultiplier,
              evaluationId: inserted.id,
              productLineMedianDaysMultipliers: Object.fromEntries(
                report.correction!.productLines
                  .filter((line) => line.eligible && line.productLineId !== null && line.medianDaysMultiplier !== null)
                  .map((line) => [line.productLineId!, line.medianDaysMultiplier!]),
              ),
            };
            await db.query(
              `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,'{forecastCorrection}',$1::jsonb),updated_at=NOW()
               WHERE config_key='default'`, [asJson(reconfirmed)],
            );
            await db.query(
              `INSERT INTO forecast_correction_events
                (seller_key,evaluation_id,correction_version,action,reason,evidence)
               VALUES($1,$2,$3,'activated','evaluation_reconfirmed',$4::jsonb)`,
              [report.sellerKey, inserted.id, version, asJson({ supersedesEvaluationId: previous.id })],
            );
          } else {
            await db.query(
              `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,'{forecastCorrection}','null'::jsonb),updated_at=NOW()
               WHERE config_key='default'`,
            );
            await db.query(
              `INSERT INTO forecast_correction_events
                (seller_key,evaluation_id,correction_version,action,reason,evidence)
               VALUES($1,$2,$3,'rolled_back','evaluation_superseded',$4::jsonb)`,
              [report.sellerKey, inserted.id, version, asJson({ supersedesEvaluationId: previous.id })],
            );
          }
        }
      }
      return { id: inserted.id, created: true };
    });
  },

  async findLatest(sellerKey: string, executor?: Queryable): Promise<(EvaluationRow & { createdAt: Date }) | null> {
    return queryOne<EvaluationRow & { createdAt: Date }>(
      `SELECT id::text AS id,report_json AS report,created_at AS "createdAt"
       FROM forecast_evaluations WHERE seller_key=$1 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
      [sellerKey.trim()], executor,
    );
  },

  async isCorrectionSupported(correction: ForecastCorrection, executor?: Queryable): Promise<boolean> {
    const row = await queryOne<{
      id: string; latestId: string; sellerKey: string; status: string; evaluatedAt: Date; report: ForecastEvaluationReport;
    }>(
      `SELECT evaluation.id::text AS id,evaluation.seller_key AS "sellerKey",evaluation.status,evaluation.evaluated_at AS "evaluatedAt",
        evaluation.report_json AS report,
        (SELECT latest.id::text FROM forecast_evaluations latest WHERE latest.seller_key=evaluation.seller_key
          ORDER BY latest.evaluated_at DESC,latest.id DESC LIMIT 1) AS "latestId"
       FROM forecast_evaluations evaluation WHERE evaluation.id=$1`,
      [correction.evaluationId], executor,
    );
    const expected = row?.report.correction;
    if (!row || row.id !== row.latestId || row.status !== "eligible" || !expected?.eligible ||
        Date.now() - row.evaluatedAt.getTime() > FORECAST_EVALUATION_POLICY.maximumEvidenceAgeDays * 86_400_000 ||
        correction.sourceModelVersion !== PRICING_MODEL_VERSION ||
        expected.sourceModelVersion !== `curve:${PRICING_MODEL_VERSION}` ||
        correction.version !== expected.version ||
        correction.medianDaysMultiplier !== expected.medianDaysMultiplier) return false;
    const expectedLines = Object.fromEntries(
      expected.productLines
        .filter((line) => line.eligible && line.productLineId !== null && line.medianDaysMultiplier !== null)
        .map((line) => [String(line.productLineId), line.medianDaysMultiplier])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    const actualLines = Object.fromEntries(
      Object.entries(correction.productLineMedianDaysMultipliers ?? {})
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) return false;
    return Boolean(row.report.materialEvidenceVersion) &&
      row.report.materialEvidenceVersion ===
        await this.findMaterialEvidenceVersion(row.sellerKey, executor);
  },

  async fallbackUnsupportedCorrection(correction: ForecastCorrection): Promise<boolean> {
    if (await this.isCorrectionSupported(correction)) return false;
    return withTransaction(async (db) => {
      const current = await queryOne<{ correction: ForecastCorrection | null }>(
        `SELECT pricing_json->'forecastCorrection' AS correction FROM pricing_config
         WHERE config_key='default' FOR UPDATE`, [], db,
      );
      if (!current?.correction || current.correction.version !== correction.version ||
          current.correction.evaluationId !== correction.evaluationId) return false;
      const evaluation = await queryOne<{ sellerKey: string }>(
        `SELECT seller_key AS "sellerKey" FROM forecast_evaluations WHERE id=$1`,
        [correction.evaluationId], db,
      );
      await db.query(
        `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,'{forecastCorrection}','null'::jsonb),updated_at=NOW()
         WHERE config_key='default'`,
      );
      if (evaluation) {
        await db.query(
          `INSERT INTO forecast_correction_events
            (seller_key,evaluation_id,correction_version,action,reason,evidence)
           VALUES($1,$2,$3,'rolled_back','unsupported_at_pricing_read',$4::jsonb)`,
          [evaluation.sellerKey, correction.evaluationId, correction.version,
            asJson({ fallback: "uncorrected_pricing_model" })],
        );
      }
      return true;
    });
  },

  async activate(input: { sellerKey: string; evaluationId: string; sourceModelVersion: string; now?: Date }): Promise<void> {
    await withTransaction(async (db) => {
      const evaluation = await queryOne<{ id: string; sellerKey: string; evaluatedAt: Date; status: string; report: ForecastEvaluationReport }>(
        `SELECT id::text AS id,seller_key AS "sellerKey",evaluated_at AS "evaluatedAt",status,report_json AS report
         FROM forecast_evaluations WHERE id=$1 AND seller_key=$2 FOR UPDATE`,
        [input.evaluationId, input.sellerKey.trim()], db,
      );
      if (!evaluation || evaluation.status !== "eligible" || !evaluation.report.correction?.eligible) {
        throw new Error("Only an eligible forecast evaluation can be activated.");
      }
      const latest = await queryOne<{ id: string }>(
        `SELECT id::text AS id FROM forecast_evaluations WHERE seller_key=$1
         ORDER BY evaluated_at DESC,id DESC LIMIT 1`, [input.sellerKey.trim()], db,
      );
      if (latest?.id !== evaluation.id) throw new Error("The forecast evaluation is stale.");
      if (!evaluation.report.materialEvidenceVersion ||
          evaluation.report.materialEvidenceVersion !==
            await this.findMaterialEvidenceVersion(input.sellerKey, db)) {
        throw new Error("The forecast evaluation evidence has changed.");
      }
      const expected = `curve:${PRICING_MODEL_VERSION}`;
      if (input.sourceModelVersion !== expected || evaluation.report.correction.sourceModelVersion !== expected) {
        throw new Error(`Forecast correction requires ${expected}.`);
      }
      const age = (input.now ?? new Date()).getTime() - evaluation.evaluatedAt.getTime();
      if (age > FORECAST_EVALUATION_POLICY.maximumEvidenceAgeDays * 86_400_000) {
        throw new Error("The forecast evaluation evidence is stale.");
      }
      const correction = {
        version: evaluation.report.correction.version,
        sourceModelVersion: PRICING_MODEL_VERSION,
        medianDaysMultiplier: evaluation.report.correction.medianDaysMultiplier,
        evaluationId: evaluation.id,
        productLineMedianDaysMultipliers: Object.fromEntries(
          evaluation.report.correction.productLines
            .filter((line) => line.eligible && line.productLineId !== null && line.medianDaysMultiplier !== null)
            .map((line) => [line.productLineId!, line.medianDaysMultiplier!]),
        ),
      };
      const current = await queryOne<{ correction: ForecastCorrection | null }>(
        `SELECT pricing_json->'forecastCorrection' AS correction FROM pricing_config
         WHERE config_key='default' FOR UPDATE`, [], db,
      );
      if (current?.correction) {
        const owner = await queryOne<{ sellerKey: string }>(
          `SELECT seller_key AS "sellerKey" FROM forecast_evaluations WHERE id=$1`,
          [current.correction.evaluationId], db,
        );
        if (owner && owner.sellerKey !== input.sellerKey.trim()) {
          throw new Error("Another seller's forecast correction is active.");
        }
      }
      await db.query(
        `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,'{forecastCorrection}',$1::jsonb),updated_at=NOW()
         WHERE config_key='default'`, [asJson(correction)],
      );
      await db.query(
        `INSERT INTO forecast_correction_events
          (seller_key,evaluation_id,correction_version,action,reason,evidence)
         VALUES($1,$2,$3,'activated','held_out_thresholds_met',$4::jsonb)`,
        [input.sellerKey.trim(), evaluation.id, correction.version,
          asJson({ sourceModelVersion: expected, thresholds: evaluation.report.policy })],
      );
    });
  },

  async rollback(input: { sellerKey: string; correctionVersion: string; reason: string }): Promise<void> {
    await withTransaction(async (db) => {
      const config = await queryOne<{ correction: Record<string, unknown> | null }>(
        `SELECT pricing_json->'forecastCorrection' AS correction FROM pricing_config
         WHERE config_key='default' FOR UPDATE`, [], db,
      );
      if (!config?.correction || config.correction.version !== input.correctionVersion) {
        throw new Error("The requested forecast correction is not active.");
      }
      const evaluationId = String(config.correction.evaluationId);
      const owner = await queryOne<{ sellerKey: string }>(
        `SELECT seller_key AS "sellerKey" FROM forecast_evaluations WHERE id=$1 FOR UPDATE`,
        [evaluationId], db,
      );
      if (!owner || owner.sellerKey !== input.sellerKey.trim()) {
        throw new Error("The requested forecast correction belongs to another seller.");
      }
      await db.query(
        `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,'{forecastCorrection}','null'::jsonb),updated_at=NOW()
         WHERE config_key='default'`,
      );
      await db.query(
        `INSERT INTO forecast_correction_events
          (seller_key,evaluation_id,correction_version,action,reason,evidence)
         VALUES($1,$2,$3,'rolled_back',$4,$5::jsonb)`,
        [input.sellerKey.trim(), evaluationId, input.correctionVersion, input.reason, asJson({ fallback: "uncorrected_pricing_model" })],
      );
    });
  },
};
