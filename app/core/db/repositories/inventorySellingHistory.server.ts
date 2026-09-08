import type {
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

    const [episodes, outcomes, productLineRows, projection, unresolvedRemoval] = await Promise.all([
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
        `SELECT DISTINCT item.product_line AS "productLine"
        FROM inventory_publication_receipt_links link
        JOIN inventory_publication_items item ON item.id=link.publication_item_id
        WHERE link.target_seller_key=$1 AND link.live_at IS NOT NULL
          AND link.live_at >= $2 AND link.live_at <= $3
        ORDER BY item.product_line LIMIT 100`,
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
    };
  },
};
