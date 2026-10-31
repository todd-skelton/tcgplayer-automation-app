//! The resolver a pricing run asks for each SKU's price (`resolveSuggestedPrice`): the SKU,
//! product and set as the catalog has them, the product line's language and variant checks, then
//! the price from the given evidence as of `now`.
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::Value;

use super::calculator::{Request, Resolve, Resolved};
use super::sku_price::{self, Config, Evidence, Failure, Sku};
use crate::database::Database;

pub struct LatestSales<'a, E> {
    pub db: &'a Database,
    pub evidence: &'a E,
    /// Epoch milliseconds the prices are for.
    pub now: f64,
}

#[derive(sqlx::FromRow)]
struct SkuRow {
    sku: i32,
    condition: String,
    variant: String,
    language: String,
    product_id: i32,
    set_id: i32,
    product_line_id: i32,
}

/// `new Date(text).getTime()` for a set's release date, read as the Node app reads it with its
/// clock in UTC: a date alone, a time without a zone, or a time with one.
pub fn release_ms(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let ms = DateTime::parse_from_rfc3339(text)
        .map(|t| t.timestamp_millis())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|t| t.and_utc().timestamp_millis())
        })
        .or_else(|_| {
            NaiveDate::parse_from_str(text, "%Y-%m-%d").map(|d| {
                d.and_hms_opt(0, 0, 0)
                    .expect("midnight")
                    .and_utc()
                    .timestamp_millis()
            })
        })
        .ok()?;
    Some(ms as f64)
}

/// The id the product line's filter gives a language or variant name, when it has one.
fn filter_id(entries: &Value, name: &str) -> bool {
    entries.as_array().into_iter().flatten().any(|entry| {
        entry.get("name").and_then(Value::as_str) == Some(name)
            && entry.get("id").is_some_and(|id| {
                !(id.is_null() || id.as_f64() == Some(0.0) || id.as_str() == Some(""))
            })
    })
}

fn failed(error: sqlx::Error) -> Failure {
    Failure::Sku(error.to_string())
}

impl<E: Evidence> Resolve for LatestSales<'_, E> {
    async fn resolve(&self, request: &Request<'_>) -> Result<Resolved, Failure> {
        let unresolved = |error: String| {
            Ok(Resolved {
                error: Some(error),
                ..Resolved::default()
            })
        };
        let row: Option<SkuRow> = sqlx::query_as(
            "SELECT sku, condition, variant, language, product_id, set_id, product_line_id
             FROM skus WHERE sku = $1 AND product_line_id = $2",
        )
        .bind(request.sku as i32)
        .bind(request.product_line_id as i32)
        .fetch_optional(&self.db.0)
        .await
        .map_err(failed)?;
        let Some(row) = row else {
            return unresolved(format!("SKU {} not found", request.sku));
        };
        let product: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM products WHERE product_id = $1 AND product_line_id = $2",
        )
        .bind(row.product_id)
        .bind(row.product_line_id)
        .fetch_optional(&self.db.0)
        .await
        .map_err(failed)?;
        let release_date: Option<Option<String>> = sqlx::query_scalar(
            "SELECT release_date FROM category_sets WHERE category_id = $1 AND set_name_id = $2",
        )
        .bind(row.product_line_id)
        .bind(row.set_id)
        .fetch_optional(&self.db.0)
        .await
        .map_err(failed)?;
        if product.is_none() {
            return unresolved(format!(
                "Product {} not found for SKU {}",
                row.product_id, row.sku
            ));
        }

        let filter: Option<(Value, Value)> = sqlx::query_as(
            "SELECT languages, variants FROM category_filters WHERE category_id = $1",
        )
        .bind(row.product_line_id)
        .fetch_optional(&self.db.0)
        .await
        .map_err(failed)?;
        let line = row.product_line_id;
        let Some((languages, variants)) = filter else {
            return Err(Failure::Sku(format!(
                "No category filter found for categoryId (productLineId) {line}"
            )));
        };
        if !filter_id(&languages, &row.language) {
            return Err(Failure::Sku(format!(
                "Language {} is not available for product line {line}",
                row.language
            )));
        }
        if !filter_id(&variants, &row.variant) {
            return Err(Failure::Sku(format!(
                "Variant {} is not available for product line {line}",
                row.variant
            )));
        }

        let sku = Sku {
            sku: row.sku.into(),
            product_id: row.product_id.into(),
            product_line_id: line.into(),
            condition: row.condition,
            variant: row.variant,
            language: row.language,
        };
        let config = Config {
            percentile: request.percentile,
            additional_percentiles: request.additional_percentiles.to_vec(),
            available_since: release_date.flatten().as_deref().and_then(release_ms),
            supply_analysis: request.supply_analysis,
            excluded_seller_key: request.excluded_seller_key.map(str::to_string),
            ..Config::default()
        };
        let priced = sku_price::price(&sku, &config, self.evidence, self.now).await?;
        Ok(Resolved::from(priced))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_dates_read_as_utc_in_every_form_the_catalog_writes() {
        let midnight = 1_721_347_200_000.0; // 2024-07-19T00:00:00Z
        assert_eq!(release_ms("2024-07-19T00:00:00"), Some(midnight));
        assert_eq!(release_ms("2024-07-19"), Some(midnight));
        assert_eq!(release_ms("2024-07-19T00:00:00Z"), Some(midnight));
        assert_eq!(release_ms(""), None);
        assert_eq!(release_ms("soon"), None);
    }

    #[test]
    fn a_language_or_variant_needs_an_id_in_the_product_lines_filter() {
        let entries =
            serde_json::json!([{ "id": 1, "name": "English" }, { "id": null, "name": "Japanese" }]);
        assert!(filter_id(&entries, "English"));
        assert!(!filter_id(&entries, "Japanese"));
        assert!(!filter_id(&entries, "German"));
    }
}
