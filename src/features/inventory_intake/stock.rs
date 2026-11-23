//! How many copies of each SKU the store has in stock: its listings for the publication seller as
//! the last inventory refresh or publication left them (`continuous_pricing_inventory`), as the
//! Product Price Matrix reads them.
use std::collections::HashMap;

use crate::{database::Database, features::continuous_pricing::store};

/// The copies in stock of each of `skus` that has any; a SKU not in the map has none. None when
/// the stock cannot be known: no publication seller is set, or the listings cannot be read. The
/// stock sits beside the counts, so the screen goes without it rather than fail.
pub async fn in_stock(db: &Database, skus: &[i32]) -> Option<HashMap<i32, i32>> {
    let read = async {
        let seller = store::settings(db).await?.seller_key;
        if seller.is_empty() {
            return Ok(None);
        }
        if skus.is_empty() {
            return Ok(Some(HashMap::new()));
        }
        let rows: Vec<(i32, i32)> = sqlx::query_as(
            "SELECT sku, quantity FROM continuous_pricing_inventory
            WHERE seller_key = $1 AND sku = ANY($2::integer[]) AND in_stock AND quantity > 0",
        )
        .bind(&seller)
        .bind(skus)
        .fetch_all(&db.0)
        .await?;
        Ok::<_, sqlx::Error>(Some(rows.into_iter().collect()))
    };
    read.await.unwrap_or_else(|error| {
        tracing::error!("[inventory-manager] Stock unavailable: {error}");
        None
    })
}
