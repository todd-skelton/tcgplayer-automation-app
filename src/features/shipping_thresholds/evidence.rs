//! The seller's recent orders as shipping evidence: what each order was worth, what the buyer
//! paid for shipping, the postage bought for it and what was in it. Ported from
//! `shippingThresholdEvidence.server.ts` (`findShippedOrders`) and `learnRecentShippingCosts`.
use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use sqlx::types::Json;

use super::{OrderEvidence, OrderLine, ShippingCostModel, SnapOutcome, cost_model};
use crate::{
    database::Database,
    features::inventory_economics::ledger::{
        assumptions::js_round,
        postage::{PostageEvidence, allocate_purchased_postage},
        proceeds::iso,
    },
};

const CURRENCY: &str = "USD";

#[derive(Deserialize)]
struct LineRow {
    sku: Option<String>,
    quantity: Option<i64>,
    value: Option<f64>,
}

#[derive(sqlx::FromRow)]
struct OrderRow {
    order_number: String,
    order_time: DateTime<Utc>,
    item_value: f64,
    buyer_shipping: Option<f64>,
    lines: Json<Vec<LineRow>>,
}

#[derive(sqlx::FromRow)]
struct PostageRow {
    provider_identity: String,
    order_numbers: Vec<String>,
    currency: Option<String>,
    rate_cents: Option<i64>,
    linked_sellers: Vec<String>,
    linked_order_count: i64,
}

/// A line's SKU when it is a whole number JavaScript holds exactly.
fn sku(text: &str) -> Option<i64> {
    let sku: f64 = text.trim().parse().ok()?;
    (sku.fract() == 0.0 && sku.abs() <= 9_007_199_254_740_991.0).then_some(sku as i64)
}

/// Orders placed since `since` that were not canceled, oldest first, with their postage.
pub async fn shipped_orders(
    db: &Database,
    seller: &str,
    since: DateTime<Utc>,
) -> sqlx::Result<Vec<OrderEvidence>> {
    let orders: Vec<OrderRow> = sqlx::query_as(
        r#"SELECT orders.order_number,date_trunc('milliseconds',orders.order_time) AS order_time,
            orders.gross_item_proceeds::float8 AS item_value,
            orders.gross_shipping_proceeds::float8 AS buyer_shipping,
            COALESCE((SELECT json_agg(json_build_object('sku',line.sku_id,'quantity',line.ordered_quantity,
              'value',line.gross_item_proceeds::float8)) FROM seller_order_lines line WHERE line.order_id=orders.id),'[]'::json) AS lines
          FROM seller_orders orders
          WHERE orders.seller_key=$1 AND orders.order_time>=$2 AND orders.lifecycle<>'canceled' AND orders.currency=$3
          ORDER BY orders.order_time,orders.order_number"#,
    )
    .bind(seller)
    .bind(since)
    .bind(CURRENCY)
    .fetch_all(&db.0)
    .await?;
    if orders.is_empty() {
        return Ok(Vec::new());
    }
    let numbers: Vec<&str> = orders.iter().map(|o| o.order_number.as_str()).collect();
    let postage: Vec<PostageRow> = sqlx::query_as(
        r#"SELECT COALESCE(purchase.easypost_shipment_id,'row:'||purchase.id::text) AS provider_identity,
            purchase.order_numbers,purchase.selected_rate_currency AS currency,
            CASE WHEN purchase.selected_rate_rate~'^[0-9]+([.][0-9]{1,2})?$'
              THEN ROUND(purchase.selected_rate_rate::numeric*100)::bigint END AS rate_cents,
            ARRAY(SELECT DISTINCT linked.seller_key FROM seller_orders linked
                  WHERE linked.order_number=ANY(purchase.order_numbers)) AS linked_sellers,
            (SELECT COUNT(*) FROM seller_orders linked
             WHERE linked.order_number=ANY(purchase.order_numbers)) AS linked_order_count
          FROM shipping_postage_purchases purchase
          WHERE purchase.mode='production' AND purchase.status='purchased' AND purchase.direction='outbound'
            AND purchase.order_numbers && $1::text[]
          ORDER BY purchase.created_at,purchase.id"#,
    )
    .bind(&numbers)
    .fetch_all(&db.0)
    .await?;
    let evidence: Vec<PostageEvidence> = postage
        .into_iter()
        .map(|row| PostageEvidence {
            provider_identity: row.provider_identity,
            order_numbers: row.order_numbers,
            currency: row.currency,
            rate_cents: row.rate_cents,
            linked_sellers: row.linked_sellers,
            linked_order_count: row.linked_order_count,
        })
        .collect();
    let postage_cents: BTreeMap<String, i64> =
        allocate_purchased_postage(seller, CURRENCY, &evidence);
    Ok(orders
        .into_iter()
        .map(|order| OrderEvidence {
            item_value: order.item_value,
            order_time: order.order_time,
            buyer_shipping: order.buyer_shipping,
            postage: postage_cents
                .get(&order.order_number)
                .map(|cents| *cents as f64 / 100.0),
            order_number: order.order_number,
            lines: order
                .lines
                .0
                .iter()
                .filter_map(|line| {
                    let sku = sku(line.sku.as_deref()?)?;
                    let quantity = line.quantity.filter(|q| *q > 0)?;
                    let value = line.value.unwrap_or(f64::NAN);
                    Some(OrderLine {
                        sku,
                        quantity: quantity as usize,
                        unit_price: js_round(value / quantity as f64 * 100.0) as f64 / 100.0,
                    })
                })
                .collect(),
        })
        .collect())
}

/// A published price whose pricing decision considered a snap.
#[derive(Clone, Debug, PartialEq)]
pub struct SnapPublication {
    pub sku: i64,
    /// When it was published, to the millisecond.
    pub published_at: DateTime<Utc>,
    pub snap: ConsideredSnap,
}

/// What the publication's decision recorded of its snap.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ConsideredSnap {
    pub threshold: f64,
    pub outcome: SnapOutcome,
}

/// `findSnapPublications`: prices published since `since` whose decision considered a snap,
/// oldest first.
pub async fn snap_publications(
    db: &Database,
    seller: &str,
    since: DateTime<Utc>,
) -> sqlx::Result<Vec<SnapPublication>> {
    let rows: Vec<(i32, DateTime<Utc>, Json<ConsideredSnap>)> = sqlx::query_as(
        r#"SELECT item.sku,date_trunc('milliseconds',item.published_at),
            item.forecast_evidence->'decision'->'shippingThresholdSnap'
          FROM inventory_publication_items item
          JOIN inventory_publications publication ON publication.id=item.publication_id
          WHERE publication.seller_key=$1 AND item.status='published' AND item.published_at>=$2
            AND item.forecast_evidence->'decision' ? 'shippingThresholdSnap'
          ORDER BY item.published_at,item.id"#,
    )
    .bind(seller)
    .bind(since)
    .fetch_all(&db.0)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(sku, published_at, snap)| SnapPublication {
            sku: i64::from(sku),
            published_at,
            snap: snap.0,
        })
        .collect())
}

/// What shipping cost the seller over the trailing window, as of `now`.
pub async fn learn_recent(
    db: &Database,
    seller: &str,
    evidence_window_days: i64,
    now: DateTime<Utc>,
) -> sqlx::Result<ShippingCostModel> {
    let orders = shipped_orders(db, seller, now - Duration::days(evidence_window_days)).await?;
    Ok(cost_model::learn(&orders, &iso(now), evidence_window_days))
}
