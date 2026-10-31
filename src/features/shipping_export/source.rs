//! Where the orders come from: TCGplayer's Ready to Ship queue or one order, read by the Node app
//! (`/api/shipping-export/tcgplayer-orders`), and the seller's order history record: how far its
//! scan has got is read and an export is imported here; moving the scan on reads TCGplayer, so it
//! stays the Node app's (`/api/seller-order-history`).
use serde::{Deserialize, Serialize};

use super::orders::Order;
use crate::{
    database::Database,
    features::{seller_order_history::file_import, shipping_configuration},
    legacy::Legacy,
};

/// How far the saved scan of the seller's orders has got.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// `running`, `complete`, `incomplete` or `not_started`.
    pub status: String,
    #[serde(default)]
    pub expected_total: Option<u64>,
    #[serde(default)]
    pub orders_observed: u64,
    #[serde(default)]
    pub details_recorded: u64,
    #[serde(default)]
    pub error: Option<String>,
}

impl Coverage {
    /// What the React screen wrote: "API history complete: 120 of 120 orders observed, ...".
    pub fn describe(&self) -> String {
        let total = self
            .expected_total
            .map_or(String::new(), |t| format!(" of {t}"));
        let error = self
            .error
            .as_deref()
            .map_or(String::new(), |e| format!(" {e}"));
        format!(
            "API history {}: {}{total} orders observed, {} details refreshed in the last scan.{error}",
            self.status.replacen('_', " ", 1),
            self.orders_observed,
            self.details_recorded,
        )
    }
}

/// Orders the Node app loaded.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub seller_key: String,
    #[serde(default)]
    pub loaded_order_numbers: Vec<String>,
    pub orders: Vec<Order>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ask<'a> {
    seller_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_number: Option<&'a str>,
}

/// The seller's orders ready to ship; an empty key is the shipping settings' seller.
pub async fn ready_to_ship(legacy: &Legacy, seller_key: &str) -> Result<Loaded, String> {
    legacy
        .send(
            "/api/shipping-export/tcgplayer-orders",
            &Ask {
                seller_key,
                order_number: None,
            },
        )
        .await
}

/// One order, whatever its status (a warning says when it is not ready to ship).
pub async fn one(legacy: &Legacy, seller_key: &str, number: &str) -> Result<Loaded, String> {
    legacy
        .send(
            "/api/shipping-export/tcgplayer-orders",
            &Ask {
                seller_key,
                order_number: Some(number),
            },
        )
        .await
}

/// A scan as read: its status, the orders it expects, has observed and recorded, and its error.
type Scan = (String, Option<i32>, i32, i32, Option<String>);

/// How far the seller's order history scan has got: its latest API scan (`getCoverage`).
pub async fn coverage(db: impl sqlx::PgExecutor<'_>, seller_key: &str) -> Result<Coverage, String> {
    let row: Option<Scan> = sqlx::query_as(
        "SELECT status, expected_total, orders_observed, details_recorded, error FROM seller_order_sync_runs
         WHERE seller_key = $1 AND source = 'tcgplayer_api' ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(seller_key.trim())
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let count = |n: i32| u64::try_from(n).unwrap_or(0);
    Ok(match row {
        None => Coverage {
            status: "not_started".to_owned(),
            expected_total: None,
            orders_observed: 0,
            details_recorded: 0,
            error: None,
        },
        Some((status, expected, observed, recorded, error)) => Coverage {
            status,
            expected_total: expected.map(count),
            orders_observed: count(observed),
            details_recorded: count(recorded),
            error: error.filter(|e| !e.is_empty()),
        },
    })
}

/// Moves the seller's order history scan on, these orders first.
pub async fn catch_up(legacy: &Legacy, seller_key: &str, orders: &[String]) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        seller_key: &'a str,
        action: &'static str,
        order_numbers: &'a [String],
    }
    legacy
        .send::<_, serde_json::Value>(
            "/api/seller-order-history",
            &Request {
                seller_key,
                action: "catch_up",
                order_numbers: orders,
            },
        )
        .await
        .map(drop)
}

/// Adds an order export older than the API's three months to the seller's order history: the
/// seller named, else the default shipping seller (as the Node route resolves it).
pub async fn import_history(
    db: &Database,
    seller_key: &str,
    file_name: &str,
    csv_text: &str,
) -> Result<file_import::Imported, String> {
    let failed = |e: sqlx::Error| e.to_string();
    let seller = match seller_key.trim() {
        "" => shipping_configuration::default_seller_key(db)
            .await
            .map_err(failed)?
            .trim()
            .to_owned(),
        named => named.to_owned(),
    };
    if seller.is_empty() {
        return Err("A seller key is required.".to_owned());
    }
    let observed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut conn = db.0.acquire().await.map_err(failed)?;
    file_import::import(&mut conn, &seller, csv_text, Some(file_name), &observed_at).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `getCoverage` for the sellers in `.port-logs/coverage.node.json`: the dev seller's
    /// scans as they are, and sellers whose runs `coverage-node.ts` seeds, in a transaction rolled
    /// back.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn coverage_reads_as_node_reads_it() {
        crate::config::load_env();
        let db = crate::database::Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Vec<serde_json::Value> =
            serde_json::from_str(&read_log("coverage.node.json")).unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("coverage-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for theirs in node {
            let seller = theirs["asked"].as_str().unwrap();
            let ours = coverage(&mut *tx, seller).await.unwrap();
            let c = &theirs["coverage"];
            assert_eq!(ours.status, c["status"], "{seller}");
            assert_eq!(ours.expected_total, c["expectedTotal"].as_u64(), "{seller}");
            assert_eq!(
                Some(ours.orders_observed),
                c["ordersObserved"].as_u64(),
                "{seller}"
            );
            assert_eq!(
                Some(ours.details_recorded),
                c["detailsRecorded"].as_u64(),
                "{seller}"
            );
            assert_eq!(ours.error.as_deref(), c["error"].as_str(), "{seller}");
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn coverage_reads_as_the_react_screen_wrote_it() {
        let coverage: Coverage = serde_json::from_value(serde_json::json!({
            "sellerKey": "s", "source": "tcgplayer_api", "status": "not_started",
            "ordersObserved": 3, "detailsRecorded": 1, "expectedTotal": 9
        }))
        .unwrap();
        assert_eq!(
            coverage.describe(),
            "API history not started: 3 of 9 orders observed, 1 details refreshed in the last scan."
        );
    }
}
