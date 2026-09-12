import type {
  HistoricalOrderRevisionEvidence,
  HistoricalPublicationAdditionEvidence,
  HistoricalPublicationEstimateEvidence,
  SellingHistoryEpisodeEvidence,
  SellingHistoryOutcomeEvidence,
  SellingHistorySourceEvidence,
  SellingHistoryScope,
} from "~/features/inventory-strategy/types/inventorySellingHistory";
import { query, queryOne } from "../database.server";
import { sellerOrderHistoryRepository } from "./sellerOrderHistory.server";

export const INVENTORY_SELLING_HISTORY_EPISODE_LIMIT = 20_000;
export const INVENTORY_SELLING_HISTORY_OUTCOME_LIMIT = 40_000;

type CountedEpisode = Omit<SellingHistoryEpisodeEvidence, "listedAt"> & {
  listedAt: Date | null;
  totalCount: number;
};

type CountedOutcome = Omit<SellingHistoryOutcomeEvidence, "happenedAt"> & {
  happenedAt: Date;
  totalCount: number;
};

const toEpisode = ({ totalCount: _totalCount, ...row }: CountedEpisode) => ({
  ...row,
  listedAt: row.listedAt?.toISOString() ?? null,
});

const toOutcome = ({ totalCount: _totalCount, ...row }: CountedOutcome) => ({
  ...row,
  happenedAt: row.happenedAt.toISOString(),
});

const HISTORICAL_PUBLICATION_LIMIT = 5_000;
const HISTORICAL_ORDER_REVISION_LIMIT = 20_000;
// Opening application could only follow complete LastThreeMonths API scans. The
// scan rows are retention-bounded, so the applied opening's copied attestations
// are the durable authority. Eighty-eight days is a conservative lower bound
// for any three-calendar-month search ending at validation completion.
const HISTORICAL_COVERAGE_MARGIN_DAYS = 88;

type OpeningHistoryAnchor = {
  observationId: string;
  cutoffAt: Date;
  validationCutoffAt: Date | null;
  observationStatus: string;
  quantitySemantics: string;
  orderCoverageEvidence: unknown;
  validationOrderCoverageEvidence: unknown;
};

function coverageAttestation(value: unknown, notBefore: Date): { finishedAt: Date } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const finishedAt = typeof row.finishedAt === "string" ? new Date(row.finishedAt) : null;
  const validCount = (field: string) => Number.isSafeInteger(row[field]) && Number(row[field]) >= 0;
  return typeof row.id === "string" && row.id.length > 0 && finishedAt &&
    Number.isFinite(finishedAt.getTime()) && finishedAt >= notBefore &&
    validCount("ordersObserved") && validCount("detailsRecorded")
      ? { finishedAt }
      : null;
}

async function historicalPublicationEvidence(
  seller: string,
  productLine: string | null,
): Promise<HistoricalPublicationEstimateEvidence> {
  const anchor = await queryOne<OpeningHistoryAnchor>(
    `SELECT run.observation_id::text AS "observationId",run.cutoff_at AS "cutoffAt",
      validation.cutoff_at AS "validationCutoffAt",observation.status AS "observationStatus",
      observation.quantity_semantics AS "quantitySemantics",
      run.order_coverage_evidence AS "orderCoverageEvidence",
      run.validation_order_coverage_evidence AS "validationOrderCoverageEvidence"
    FROM inventory_opening_balance_runs run
    JOIN inventory_complete_observations observation ON observation.id=run.observation_id
      AND observation.seller_key=run.seller_key
    LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
      AND validation.seller_key=run.seller_key
    WHERE run.seller_key=$1 AND run.status='applied'`,
    [seller],
  );
  if (!anchor) return {
    sourceAvailable:true,cutoffAt:null,coverageStartsAt:null,coverageComplete:false,validatedAt:null,
    additions:[],additionCount:0,
    openingQuantities:[],orderRevisions:[],orderRevisionCount:0,
  };

  const firstCoverage = coverageAttestation(anchor.orderCoverageEvidence, anchor.cutoffAt);
  const validationCoverage = anchor.validationCutoffAt
    ? coverageAttestation(anchor.validationOrderCoverageEvidence, anchor.validationCutoffAt)
    : null;
  const coverageComplete = anchor.observationStatus === "complete" &&
    anchor.quantitySemantics === "sellable_excludes_reserved" &&
    anchor.validationCutoffAt !== null && anchor.validationCutoffAt >= anchor.cutoffAt &&
    firstCoverage !== null && validationCoverage !== null;
  const coverageStartsAt = validationCoverage
    ? new Date(validationCoverage.finishedAt.getTime() - HISTORICAL_COVERAGE_MARGIN_DAYS * 86_400_000)
    : null;

  const additionRows = await query<HistoricalPublicationAdditionEvidence & { totalCount: number }>(
      `SELECT item.id::int AS "publicationItemId",item.sku,item.product_line AS "productLine",
        item.product_name AS "productName",item.quantity_delta AS quantity,
        publication.source_type AS "sourceType",publication.method,item.inventory_delta_key AS "inventoryDeltaKey",
        batch_match.item_count AS "batchItemCount",batch_match.add_to_quantity AS "batchAddToQuantity",
        sku_identity.product_line_count AS "skuProductLineCount",
        linked_history.publication_count AS "linkedPreCutoffPublicationCount",
        publication.publishing_at AS "publishingAt",item.published_at AS "confirmedAt",
        item.forecast_evidence AS "forecastEvidence",
        item.forecast_evidence_provenance AS "forecastEvidenceProvenance",COUNT(*) OVER()::int AS "totalCount"
      FROM inventory_publication_items item
      JOIN inventory_publications publication ON publication.id=item.publication_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_count,MAX(batch_item.add_to_quantity)::int AS add_to_quantity
        FROM inventory_batch_items batch_item
        WHERE batch_item.batch_number=item.batch_number AND batch_item.sku=item.sku
      ) batch_match ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT sibling.product_line)::int AS product_line_count
        FROM inventory_publication_items sibling
        JOIN inventory_publications sibling_publication
          ON sibling_publication.id=sibling.publication_id
        WHERE sibling_publication.seller_key=$1 AND sibling.sku=item.sku
          AND sibling.status='published' AND sibling.quantity_delta>0
          AND sibling.created_at<$2
          AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links sibling_link
            WHERE sibling_link.publication_item_id=sibling.id)
      ) sku_identity ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT sibling.id)::int AS publication_count
        FROM inventory_publication_items sibling
        JOIN inventory_publications sibling_publication
          ON sibling_publication.id=sibling.publication_id
        JOIN inventory_publication_receipt_links sibling_link
          ON sibling_link.publication_item_id=sibling.id
        WHERE sibling_publication.seller_key=$1 AND sibling.sku=item.sku
          AND sibling.status='published' AND sibling.quantity_delta>0
          AND sibling.published_at<$2
      ) linked_history ON TRUE
      WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
        AND item.created_at<$2
        AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
          WHERE link.publication_item_id=item.id)
        AND ($3::text IS NULL OR item.product_line=$3)
      ORDER BY item.published_at NULLS LAST,item.id LIMIT $4`,
      [seller, anchor.cutoffAt, productLine, HISTORICAL_PUBLICATION_LIMIT],
    );
  const additionCount = additionRows[0]?.totalCount ?? 0;
  const additions = additionRows.map(({ totalCount: _totalCount, ...row }) => ({
    ...row,
    publishingAt: row.publishingAt ? new Date(row.publishingAt).toISOString() : null,
    confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
  }));
  const skus = [...new Set(additions.map((row) => row.sku))];
  if (skus.length === 0) return {
    sourceAvailable:true,cutoffAt:anchor.cutoffAt.toISOString(),coverageStartsAt:coverageStartsAt?.toISOString()??null,
    validatedAt:validationCoverage?.finishedAt.toISOString()??null,
    coverageComplete,additions:[],additionCount,
    openingQuantities:[],orderRevisions:[],orderRevisionCount:0,
  };

  const [openingQuantities, orderRows] = await Promise.all([
    query<{ sku: number; quantity: number }>(
      `SELECT sku,quantity FROM inventory_complete_observation_items
      WHERE observation_id=$1 AND sku=ANY($2::int[]) ORDER BY sku`,
      [anchor.observationId, skus],
    ),
    query<HistoricalOrderRevisionEvidence & { totalCount: number }>(
      `WITH relevant_orders AS (
        SELECT DISTINCT revision.order_id
        FROM seller_order_revisions revision
        JOIN seller_orders orders ON orders.id=revision.order_id
        CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) line
        WHERE orders.seller_key=$1 AND COALESCE(revision.order_time,orders.order_time)>=$2
          AND COALESCE(revision.order_time,orders.order_time)<$3
          AND (line->>'skuId')=ANY($4::text[])
      )
      SELECT revision.order_id::text AS "orderId",orders.order_number AS "orderNumber",
        revision.revision_number AS "revisionNumber",revision.observed_at AS "observedAt",
        revision.order_time AS "orderTime",
        revision.order_time_evidence AS "orderTimeEvidence",revision.lifecycle,
        revision.line_evidence AS lines,COUNT(*) OVER()::int AS "totalCount"
      FROM relevant_orders relevant
      JOIN seller_order_revisions revision ON revision.order_id=relevant.order_id
      JOIN seller_orders orders ON orders.id=revision.order_id
      ORDER BY revision.order_id,revision.revision_number LIMIT $5`,
      [seller, coverageStartsAt ?? anchor.cutoffAt, anchor.cutoffAt, skus.map(String), HISTORICAL_ORDER_REVISION_LIMIT],
    ),
  ]);
  const orderRevisionCount = orderRows[0]?.totalCount ?? 0;
  return {
    sourceAvailable:true,cutoffAt:anchor.cutoffAt.toISOString(),coverageStartsAt:coverageStartsAt?.toISOString()??null,
    validatedAt:validationCoverage?.finishedAt.toISOString()??null,
    coverageComplete,additions,additionCount,openingQuantities,
    orderRevisions:orderRows.map(({totalCount:_totalCount,...row})=>({
      ...row,observedAt:new Date(row.observedAt).toISOString(),
      orderTime:row.orderTime?new Date(row.orderTime).toISOString():null,
    })),orderRevisionCount,
  };
}

async function safeHistoricalPublicationEvidence(
  seller: string,
  productLine: string | null,
): Promise<HistoricalPublicationEstimateEvidence> {
  try {
    return await historicalPublicationEvidence(seller, productLine);
  } catch (error) {
    console.error("Historical publication evidence is unavailable:", error);
    return {
      sourceAvailable:false,cutoffAt:null,coverageStartsAt:null,coverageComplete:false,
      validatedAt:null,additions:[],additionCount:0,openingQuantities:[],orderRevisions:[],
      orderRevisionCount:0,
    };
  }
}

export const inventorySellingHistoryRepository = {
  async findEvidence(
    sellerKey: string,
    scope: SellingHistoryScope,
  ): Promise<SellingHistorySourceEvidence> {
    const seller = sellerKey.trim();
    if (!seller) throw new Error("Seller key is required.");

    const [orderCoverage, observation] = await Promise.all([
      sellerOrderHistoryRepository.getCoverage(seller),
      queryOne<{ cutoffAt: Date }>(
        `SELECT cutoff_at AS "cutoffAt"
        FROM inventory_complete_observations
        WHERE seller_key=$1 AND status='complete'
        ORDER BY cutoff_at DESC,id DESC LIMIT 1`,
        [seller],
      ),
    ]);

    const asOf = orderCoverage.completedAt
      ? new Date(orderCoverage.completedAt)
      : new Date();
    const analysisFrom = new Date(
      asOf.getTime() - scope.windowDays * 86_400_000,
    );

    const [episodes, outcomes, productLineRows, projection, unresolvedRemoval, historicalPublication] = await Promise.all([
      query<CountedEpisode>(
        `WITH all_episodes AS (
          SELECT 'receipt:'||receipt.receipt_id::text AS "episodeKey",
            receipt.receipt_id AS "receiptId",receipt.sku,
            COALESCE(item.product_line,catalog.product_line_name,'Unknown') AS "productLine",
            COALESCE(item.product_name,catalog.product_name,'SKU '||receipt.sku::text) AS "productName",
            'confirmed_publication'::text AS kind,link.planned_quantity AS quantity,
            link.live_at AS "listedAt",item.forecast_evidence AS "forecastEvidence",
            item.forecast_evidence_provenance AS "forecastEvidenceProvenance"
          FROM inventory_publication_receipt_links link
          JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
          JOIN inventory_publication_items item ON item.id=link.publication_item_id
          LEFT JOIN skus catalog ON catalog.sku=receipt.sku
          WHERE link.target_seller_key=$1 AND link.live_at >= $2 AND link.live_at <= $3
          UNION ALL
          SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key,
            receipt.receipt_id,disposition.sku,
            COALESCE(item.product_line,catalog.product_line_name,'Unknown'),
            COALESCE(item.product_name,catalog.product_name,'SKU '||disposition.sku::text),
            'physical_restock',mapping.quantity,NULL,NULL,'unknown'
          FROM inventory_stock_dispositions disposition
          JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
          JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
          LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
          LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
          LEFT JOIN skus catalog ON catalog.sku=receipt.sku
          WHERE disposition.seller_key=$1 AND disposition.available_at >= $2
            AND disposition.available_at <= $3
          UNION ALL
          SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key,
            receipt.receipt_id,correction.sku,
            COALESCE(item.product_line,catalog.product_line_name,'Unknown'),
            COALESCE(item.product_name,catalog.product_name,'SKU '||correction.sku::text),
            'order_quantity_correction',mapping.quantity,NULL,NULL,'unknown'
          FROM inventory_order_quantity_corrections correction
          JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
          JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
          LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
          LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
          LEFT JOIN skus catalog ON catalog.sku=receipt.sku
          WHERE correction.seller_key=$1 AND correction.available_at >= $2
            AND correction.available_at <= $3
        ), episodes AS (
          SELECT * FROM all_episodes
          WHERE $4::text IS NULL OR "productLine"=$4
        )
        SELECT episodes.*,COUNT(*) OVER()::int AS "totalCount"
        FROM episodes ORDER BY "listedAt" NULLS LAST,"episodeKey"
        LIMIT $5`,
        [seller, analysisFrom, asOf, scope.productLine, INVENTORY_SELLING_HISTORY_EPISODE_LIMIT],
      ),
      query<CountedOutcome>(
        `WITH episode_keys AS (
          SELECT 'receipt:'||link.receipt_id::text AS key
          FROM inventory_publication_receipt_links link
          JOIN inventory_publication_items item ON item.id=link.publication_item_id
          WHERE link.target_seller_key=$1 AND link.live_at >= $2 AND link.live_at <= $3
            AND ($4::text IS NULL OR item.product_line=$4)
          UNION ALL
          SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key
          FROM inventory_stock_dispositions disposition
          JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
          JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
          LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
          LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
          LEFT JOIN skus catalog ON catalog.sku=receipt.sku
          WHERE disposition.seller_key=$1 AND disposition.available_at >= $2
            AND disposition.available_at <= $3
            AND ($4::text IS NULL OR COALESCE(item.product_line,catalog.product_line_name,'Unknown')=$4)
          UNION ALL
          SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key
          FROM inventory_order_quantity_corrections correction
          JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
          JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
          LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
          LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
          LEFT JOIN skus catalog ON catalog.sku=receipt.sku
          WHERE correction.seller_key=$1 AND correction.available_at >= $2
            AND correction.available_at <= $3
            AND ($4::text IS NULL OR COALESCE(item.product_line,catalog.product_line_name,'Unknown')=$4)
        ), outcomes AS (
          SELECT allocation.supply_key AS "episodeKey",
            CASE WHEN orders.lifecycle='canceled' THEN 'removed' ELSE 'sale' END::text AS kind,
            allocation.allocated_quantity AS quantity,orders.order_time AS "happenedAt",
            orders.order_number AS "orderNumber",line.id::text AS "orderLineId",
            CASE WHEN orders.lifecycle='canceled' THEN 'cancellation' ELSE 'seller_order' END::text AS source
          FROM inventory_fifo_lines line
          JOIN seller_orders orders ON orders.id=line.order_id
          JOIN inventory_fifo_revision_allocations allocation
            ON allocation.revision_id=line.current_revision_id
          JOIN episode_keys episode ON episode.key=allocation.supply_key
          LEFT JOIN inventory_fifo_replay_queue replay
            ON replay.seller_key=line.seller_key AND replay.sku=line.sku
          WHERE line.seller_key=$1 AND replay.seller_key IS NULL
            AND orders.order_time >= $2 AND orders.order_time <= $3
            AND line.state IN ('allocated','partial','unmatched')
            AND orders.lifecycle IN ('processing','ready_to_ship','shipped_in_transit',
              'shipped_delivered','completed_paid','canceled')
          UNION ALL
          SELECT mapping.source_supply_key,'removed',mapping.quantity,correction.available_at,
            orders.order_number,line.id::text,'quantity_correction'
          FROM inventory_order_quantity_corrections correction
          JOIN inventory_order_quantity_correction_allocations mapping
            ON mapping.correction_id=correction.id
          JOIN episode_keys episode ON episode.key=mapping.source_supply_key
          JOIN seller_orders orders ON orders.id=correction.order_id
          LEFT JOIN inventory_fifo_lines line ON line.order_id=correction.order_id
            AND line.order_line_sku_id=correction.order_line_sku_id
          WHERE correction.seller_key=$1 AND correction.available_at >= $2
            AND correction.available_at <= $3
        )
        SELECT outcomes.*,COUNT(*) OVER()::int AS "totalCount"
        FROM outcomes ORDER BY "happenedAt","episodeKey" LIMIT $5`,
        [seller, analysisFrom, asOf, scope.productLine, INVENTORY_SELLING_HISTORY_OUTCOME_LIMIT],
      ),
      query<{ productLine: string }>(
        `SELECT DISTINCT source."productLine" FROM (
          SELECT item.product_line AS "productLine"
          FROM inventory_publication_receipt_links link
          JOIN inventory_publication_items item ON item.id=link.publication_item_id
          WHERE link.target_seller_key=$1 AND link.live_at IS NOT NULL
            AND link.live_at >= $2 AND link.live_at <= $3
          UNION ALL
          SELECT item.product_line
          FROM inventory_publication_items item
          JOIN inventory_publications publication ON publication.id=item.publication_id
          WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
            AND item.created_at >= $2 AND item.created_at <= $3
            AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
              WHERE link.publication_item_id=item.id)
        ) source ORDER BY source."productLine" LIMIT 100`,
        [seller, new Date(asOf.getTime() - 730 * 86_400_000), asOf],
      ),
      queryOne<{ pendingQuantity: number; heldQuantity: number; affectedSkus: number[]; openingUnknownQuantity: number; legacyUnlinkedQuantity: number; legacyUnlinkedForecastQuantity: number; olderPublicationQuantity: number; awaitingCutoffQuantity: number }>(
        `SELECT
          COALESCE(SUM(line.ordered_quantity) FILTER (
            WHERE replay.status IN ('pending','processing') OR
              (replay.status IS NULL AND line.state='pending')),0)::int AS "pendingQuantity",
          COALESCE(SUM(line.ordered_quantity) FILTER (
            WHERE replay.status='held' OR
              (replay.status IS NULL AND line.state='held')),0)::int AS "heldQuantity"
          ,COALESCE(array_agg(DISTINCT line.sku) FILTER (
            WHERE line.sku IS NOT NULL AND (replay.seller_key IS NOT NULL OR
              line.state IN ('pending','held'))),'{}') AS "affectedSkus",
          (SELECT COALESCE(SUM(receipt.original_quantity),0)::int
            FROM inventory_receipts receipt
            JOIN inventory_opening_balance_runs opening
              ON opening.id=receipt.opening_balance_run_id AND opening.status='applied'
            LEFT JOIN skus opening_catalog ON opening_catalog.sku=receipt.sku
            WHERE receipt.seller_key=$1 AND receipt.receipt_kind='opening_balance'
              AND ($4::text IS NULL OR COALESCE(opening_catalog.product_line_name,'Unknown')=$4)) AS "openingUnknownQuantity"
          ,(SELECT COALESCE(SUM(item.quantity_delta),0)::int
            FROM inventory_publication_items item
            JOIN inventory_publications publication ON publication.id=item.publication_id
            WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
              AND ($4::text IS NULL OR item.product_line=$4)
              AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
                WHERE link.publication_item_id=item.id)) AS "legacyUnlinkedQuantity"
          ,(SELECT COALESCE(SUM(item.quantity_delta),0)::int
            FROM inventory_publication_items item
            JOIN inventory_publications publication ON publication.id=item.publication_id
            WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
              AND ($4::text IS NULL OR item.product_line=$4)
              AND item.forecast_evidence IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
                WHERE link.publication_item_id=item.id)) AS "legacyUnlinkedForecastQuantity",
          (SELECT COALESCE(SUM(link.planned_quantity),0)::int
            FROM inventory_publication_receipt_links link
            JOIN inventory_publication_items item ON item.id=link.publication_item_id
            WHERE link.target_seller_key=$1 AND link.live_at<$2
              AND ($4::text IS NULL OR item.product_line=$4)) AS "olderPublicationQuantity",
          (SELECT COALESCE(SUM(awaiting.quantity),0)::int FROM (
            SELECT link.planned_quantity AS quantity,item.product_line AS "productLine"
            FROM inventory_publication_receipt_links link
            JOIN inventory_publication_items item ON item.id=link.publication_item_id
            WHERE link.target_seller_key=$1 AND link.live_at>$3
            UNION ALL
            SELECT mapping.quantity,COALESCE(item.product_line,catalog.product_line_name,'Unknown')
            FROM inventory_stock_dispositions disposition
            JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
            JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
            LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
            LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
            LEFT JOIN skus catalog ON catalog.sku=receipt.sku
            WHERE disposition.seller_key=$1 AND disposition.available_at>$3
            UNION ALL
            SELECT mapping.quantity,COALESCE(item.product_line,catalog.product_line_name,'Unknown')
            FROM inventory_order_quantity_corrections correction
            JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
            JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
            LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
            LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
            LEFT JOIN skus catalog ON catalog.sku=receipt.sku
            WHERE correction.seller_key=$1 AND correction.available_at>$3
          ) awaiting WHERE $4::text IS NULL OR awaiting."productLine"=$4) AS "awaitingCutoffQuantity"
        FROM inventory_fifo_lines line
        LEFT JOIN inventory_fifo_replay_queue replay
          ON replay.seller_key=line.seller_key AND replay.sku=line.sku
        LEFT JOIN skus line_catalog ON line_catalog.sku=line.sku
        WHERE line.seller_key=$1
          AND ($4::text IS NULL OR COALESCE(line_catalog.product_line_name,'Unknown')=$4)`,
        [seller, analysisFrom, asOf, scope.productLine],
      ),
      queryOne<{ quantity: number; affectedSkus: number[] }>(
        `WITH held AS (
          SELECT replay.sku,
            substring(replay.hold_reason FROM 'observed_(-?[0-9]+)')::int AS observed,
            substring(replay.hold_reason FROM 'expected_(-?[0-9]+)')::int AS expected
          FROM inventory_fifo_replay_queue replay
          LEFT JOIN skus catalog ON catalog.sku=replay.sku
          WHERE replay.seller_key=$1 AND replay.status='held'
            AND replay.hold_reason ~ '^unexplained_inventory_difference:[0-9]+:observed_-?[0-9]+:expected_-?[0-9]+$'
            AND ($2::text IS NULL OR COALESCE(catalog.product_line_name,'Unknown')=$2)
        ), removals AS (
          SELECT sku,GREATEST(expected-observed,0)::int AS quantity FROM held
        )
        SELECT COALESCE(SUM(quantity),0)::int AS quantity,
          COALESCE(array_agg(DISTINCT sku) FILTER (WHERE quantity>0),'{}') AS "affectedSkus"
        FROM removals`,
        [seller, scope.productLine],
      ),
      safeHistoricalPublicationEvidence(seller, scope.productLine),
    ]);

    return {
      sellerKey: seller,
      scope,
      availableProductLines: productLineRows.map((row) => row.productLine),
      analysisFrom: analysisFrom.toISOString(),
      inventoryObservedAt: observation?.cutoffAt.toISOString() ?? null,
      orderCoverage,
      episodes: episodes.map(toEpisode),
      episodeCount: episodes[0]?.totalCount ?? 0,
      outcomes: outcomes.map(toOutcome),
      outcomeCount: outcomes[0]?.totalCount ?? 0,
      projection: {
        pendingQuantity: projection?.pendingQuantity ?? 0,
        heldQuantity: projection?.heldQuantity ?? 0,
        affectedSkus: projection?.affectedSkus ?? [],
      },
      openingUnknownQuantity: projection?.openingUnknownQuantity ?? 0,
      legacyUnlinked: {
        quantity: projection?.legacyUnlinkedQuantity ?? 0,
        forecastQuantity: projection?.legacyUnlinkedForecastQuantity ?? 0,
      },
      olderPublicationQuantity: projection?.olderPublicationQuantity ?? 0,
      awaitingCutoffQuantity: projection?.awaitingCutoffQuantity ?? 0,
      unresolvedRemoval: unresolvedRemoval ?? { quantity: 0, affectedSkus: [] },
      historicalPublicationEvidence: historicalPublication,
    };
  },
};
