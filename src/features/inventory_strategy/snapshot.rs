//! The seller's in-stock inventory with the latest pricing curve of each SKU, as the strategy
//! reads it: `inventoryStrategyRepository.findSnapshot` and `findSnapshotVersion`.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::types::Json;

use crate::{
    database::Database,
    features::{
        inventory_economics::ledger::proceeds::iso,
        pricing::{marketplace_price::PriceEvidence, policy::PersistedDecision},
    },
};

/// What a SKU's latest pricing recorded.
#[derive(Clone, Debug, PartialEq)]
pub struct PricingDetails {
    pub persisted: PersistedDecision,
    pub price_evidence: PriceEvidence,
    /// Entries in its percentiles, readable or not.
    pub percentile_count: usize,
}

impl PricingDetails {
    pub fn of(json: &Value) -> Self {
        PricingDetails {
            persisted: PersistedDecision::from_json(json),
            price_evidence: json
                .get("priceEvidence")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
                .unwrap_or_default(),
            percentile_count: json["percentiles"].as_array().map_or(0, Vec::len),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotItem {
    pub seller_key: String,
    pub sku: i64,
    pub product_id: i64,
    pub product_line_id: i64,
    pub set_id: i64,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub variant: String,
    pub quantity: i64,
    pub current_price: Option<f64>,
    pub market_price: Option<f64>,
    pub pricing_eligible: bool,
    pub pricing_details: Option<PricingDetails>,
    pub strategy_priced_at: Option<DateTime<Utc>>,
}

type Row = (
    String,
    i64,
    i64,
    i64,
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<f64>,
    Option<f64>,
    bool,
    Option<Json<Value>>,
    Option<DateTime<Utc>>,
);

const IN_STOCK: &str =
    "WHERE inventory.seller_key = $1 AND inventory.in_stock AND inventory.quantity > 0";

/// Changes whenever the in-stock inventory or any of its curves change.
pub async fn find_version(db: &Database, seller: &str) -> sqlx::Result<String> {
    let (inventory_count, inventory_updated_at, curve_count, curve_updated_at): (
        i64,
        Option<DateTime<Utc>>,
        i64,
        Option<DateTime<Utc>>,
    ) = sqlx::query_as(&format!(
        "SELECT COUNT(*), MAX(inventory.updated_at), COUNT(curve.sku), MAX(curve.updated_at)
         FROM continuous_pricing_inventory inventory
         LEFT JOIN inventory_strategy_pricing_curves curve
           ON curve.seller_key = inventory.seller_key AND curve.sku = inventory.sku
         {IN_STOCK}"
    ))
    .bind(seller)
    .fetch_one(&db.0)
    .await?;
    Ok([
        inventory_count.to_string(),
        inventory_updated_at.map(iso).unwrap_or_default(),
        curve_count.to_string(),
        curve_updated_at.map(iso).unwrap_or_default(),
    ]
    .join(":"))
}

pub async fn find(db: &Database, seller: &str) -> sqlx::Result<Vec<SnapshotItem>> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT inventory.seller_key, inventory.sku::bigint, inventory.product_id::bigint,
           inventory.product_line_id::bigint, inventory.set_id::bigint, inventory.product_line,
           inventory.set_name, inventory.product_name, inventory.condition, inventory.variant,
           inventory.quantity::bigint, inventory.current_price::float8, inventory.market_price::float8,
           inventory.pricing_eligible, curve.pricing_details_json,
           COALESCE((curve.pricing_details_json->>'marketDataAt')::timestamptz, curve.priced_at)
         FROM continuous_pricing_inventory inventory
         LEFT JOIN inventory_strategy_pricing_curves curve
           ON curve.seller_key = inventory.seller_key AND curve.sku = inventory.sku
         {IN_STOCK}
         ORDER BY inventory.product_line, inventory.sku"
    ))
    .bind(seller)
    .fetch_all(&db.0)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| SnapshotItem {
            seller_key: row.0,
            sku: row.1,
            product_id: row.2,
            product_line_id: row.3,
            set_id: row.4,
            product_line: row.5,
            set_name: row.6,
            product_name: row.7,
            condition: row.8,
            variant: row.9,
            quantity: row.10,
            current_price: row.11,
            market_price: row.12,
            pricing_eligible: row.13,
            pricing_details: row.14.map(|Json(details)| PricingDetails::of(&details)),
            strategy_priced_at: row.15,
        })
        .collect())
}
