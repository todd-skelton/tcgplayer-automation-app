//! The seller's economics workspace as the Node app's `/api/inventory-economics` answers it
//! (`loadInventoryEconomicsWorkspace`): the 100 most recently recorded purchases, funding
//! adjustments and order expenses, each with up to 25 versions of its history, from Node's SQL as
//! written (`crate::node_pg`), and the 100 newest orders' economics.
use serde_json::{Value, json};

use super::ledger::{evidence, orders::calculate_orders, proceeds::iso};
use sqlx::PgConnection;

use crate::{database::Database, node_pg};

/// How many of each the workspace reads, as Node's does.
const RECENT: i64 = 100;

/// `listPurchaseCosts`.
const PURCHASE_COSTS: &str = r#"WITH selected_series AS (
        SELECT series.id,MAX(entry.recorded_at) AS latest_recorded_at
        FROM inventory_purchase_cost_series series
        JOIN inventory_purchase_cost_entries entry ON entry.series_id=series.id
        WHERE series.seller_key=$1 GROUP BY series.id
        ORDER BY latest_recorded_at DESC,series.id DESC LIMIT $2
      ), history AS (
        SELECT entry.*,ROW_NUMBER() OVER (PARTITION BY entry.series_id ORDER BY entry.sequence DESC) AS history_rank,
          COUNT(*) OVER (PARTITION BY entry.series_id)::int AS history_count,
          selected.latest_recorded_at
        FROM selected_series selected
        JOIN inventory_purchase_cost_entries entry ON entry.series_id=selected.id
      )
      SELECT entry.id::text AS id,entry.sequence AS version,series.purchase_reference AS "purchaseReference",series.currency,
        entry.total_amount_cents::float8 AS "totalAmountCents",entry.provenance,entry.source,
        entry.allocation_rule AS "allocationRule",entry.batch_numbers AS "batchNumbers",
        entry.purchased_at::text AS "purchasedAt",entry.recorded_at AS "recordedAt",
        entry.history_rank=1 AS "isCurrent",entry.history_count AS "historyCount",
        entry.history_count<=25 AS "historyComplete",
        entry.corrects_entry_id::text AS "correctsEntryId",entry.correction_reason AS "correctionReason",
        entry.request_fingerprint AS "evidenceIdentity"
       FROM inventory_purchase_cost_series series
       JOIN history entry ON entry.series_id=series.id
       WHERE entry.history_rank<=25
       ORDER BY entry.latest_recorded_at DESC,series.id DESC,entry.sequence DESC"#;

/// `listFundingAdjustments`.
const FUNDING_ADJUSTMENTS: &str = r#"WITH selected_series AS (
        SELECT series.id,MAX(entry.recorded_at) AS latest_recorded_at
        FROM inventory_funding_series series
        JOIN inventory_funding_entries entry ON entry.series_id=series.id
        WHERE series.seller_key=$1 GROUP BY series.id
        ORDER BY latest_recorded_at DESC,series.id DESC LIMIT $2
      ), history AS (
        SELECT entry.*,ROW_NUMBER() OVER (PARTITION BY entry.series_id ORDER BY entry.sequence DESC) AS history_rank,
          COUNT(*) OVER (PARTITION BY entry.series_id)::int AS history_count,
          selected.latest_recorded_at
        FROM selected_series selected
        JOIN inventory_funding_entries entry ON entry.series_id=selected.id
      )
      SELECT entry.id::text AS id,entry.sequence AS version,series.adjustment_reference AS "adjustmentReference",series.currency,
        entry.adjustment_type AS "adjustmentType",entry.amount_cents::float8 AS "amountCents",
        entry.provenance,entry.effective_at::text AS "effectiveAt",entry.purchase_reference AS "purchaseReference",
        entry.recorded_at AS "recordedAt",
        entry.history_rank=1 AS "isCurrent",entry.history_count AS "historyCount",
        entry.history_count<=25 AS "historyComplete",
        entry.corrects_entry_id::text AS "correctsEntryId",entry.correction_reason AS "correctionReason",
        entry.request_fingerprint AS "evidenceIdentity"
       FROM inventory_funding_series series
       JOIN history entry ON entry.series_id=series.id
       WHERE entry.history_rank<=25
       ORDER BY entry.latest_recorded_at DESC,series.id DESC,entry.sequence DESC"#;

/// `listOrderExpenses`.
const ORDER_EXPENSES: &str = r#"WITH selected_series AS (
        SELECT series.id,MAX(entry.recorded_at) AS latest_recorded_at
        FROM inventory_order_expense_series series
        JOIN inventory_order_expense_entries entry ON entry.series_id=series.id
        WHERE series.seller_key=$1 GROUP BY series.id
        ORDER BY latest_recorded_at DESC,series.id DESC LIMIT $2
      ), history AS (
        SELECT entry.*,ROW_NUMBER() OVER (PARTITION BY entry.series_id ORDER BY entry.sequence DESC) AS history_rank,
          COUNT(*) OVER (PARTITION BY entry.series_id)::int AS history_count,
          selected.latest_recorded_at
        FROM selected_series selected
        JOIN inventory_order_expense_entries entry ON entry.series_id=selected.id
      )
      SELECT entry.id::text AS id,entry.sequence AS version,series.expense_reference AS "expenseReference",series.currency,
        entry.expense_type AS "expenseType",entry.amount_cents::float8 AS "amountCents",entry.provenance,
        entry.order_numbers AS "orderNumbers",entry.expense_at::text AS "expenseAt",entry.basis,
        entry.recorded_at AS "recordedAt",
        entry.history_rank=1 AS "isCurrent",entry.history_count AS "historyCount",
        entry.history_count<=25 AS "historyComplete",
        entry.corrects_entry_id::text AS "correctsEntryId",entry.correction_reason AS "correctionReason",
        entry.request_fingerprint AS "evidenceIdentity",entry.financial_source_fingerprint AS "financialSourceFingerprint"
       FROM inventory_order_expense_series series
       JOIN history entry ON entry.series_id=series.id
       WHERE entry.history_rank<=25
       ORDER BY entry.latest_recorded_at DESC,series.id DESC,entry.sequence DESC"#;

async fn list(db: impl sqlx::PgExecutor<'_>, sql: &str, seller: &str) -> Result<Value, String> {
    let rows = sqlx::query(sql)
        .bind(seller.trim())
        .bind(RECENT)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    node_pg::rows(&rows)
}

/// The workspace for `seller`.
pub async fn read(db: &Database, seller: &str) -> Result<Value, String> {
    let seller = seller.trim();
    let (purchase_costs, funding_adjustments, order_expenses, evidence) = tokio::join!(
        list(&db.0, PURCHASE_COSTS, seller),
        list(&db.0, FUNDING_ADJUSTMENTS, seller),
        list(&db.0, ORDER_EXPENSES, seller),
        evidence::find(db, seller, RECENT),
    );
    let evidence = evidence.map_err(|e| e.to_string())?;
    workspace(
        seller,
        [purchase_costs?, funding_adjustments?, order_expenses?],
        &evidence,
    )
}

/// [`read`] on one connection, so it sees what the connection's transaction recorded.
pub async fn read_on(conn: &mut PgConnection, seller: &str) -> Result<Value, String> {
    let seller = seller.trim();
    let purchase_costs = list(&mut *conn, PURCHASE_COSTS, seller).await?;
    let funding_adjustments = list(&mut *conn, FUNDING_ADJUSTMENTS, seller).await?;
    let order_expenses = list(&mut *conn, ORDER_EXPENSES, seller).await?;
    let evidence = evidence::find_in(conn, seller, RECENT)
        .await
        .map_err(|e| e.to_string())?;
    workspace(
        seller,
        [purchase_costs, funding_adjustments, order_expenses],
        &evidence,
    )
}

fn workspace(
    seller: &str,
    [purchase_costs, funding_adjustments, order_expenses]: [Value; 3],
    evidence: &evidence::Evidence,
) -> Result<Value, String> {
    let orders: Vec<Value> = calculate_orders(seller, evidence)?
        .iter()
        .map(|order| order.summary())
        .collect();
    Ok(json!({
        "sellerKey": seller,
        "generatedAt": iso(chrono::Utc::now()),
        "purchaseCosts": purchase_costs,
        "fundingAdjustments": funding_adjustments,
        "orderExpenses": order_expenses,
        "orders": orders,
    }))
}
