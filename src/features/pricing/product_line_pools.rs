//! Each product line's pooled sale rates, from its latest stored modeled results: the prior a
//! shrunk forecast leans on (`super::shrunk_sale_rate`). Read once per pricing run, so a run of one
//! SKU still has its line's rate to shrink toward.
use chrono::{DateTime, Duration, Utc};

use super::{
    policy::MODEL_VERSION,
    shrunk_sale_rate::{Exposure, Pool, Pools},
};

/// Days of stored results a product line's pool is read from.
pub const POOL_DAYS: i64 = 30;

/// Each SKU's latest result priced in the window counts once, when the current model priced it
/// from its curve: its qualifying sales over sales times the buyer interval, and the same for its
/// condition rate's transactions. Fields are read from one `jsonb_to_record` per result, so the
/// pricing details are read once each.
const POOLS: &str = r#"
  WITH latest AS (
    SELECT DISTINCT ON (sku) batch_number, sku
    FROM inventory_batch_results
    WHERE priced_at >= $1 AND priced_at < $2
    ORDER BY sku, priced_at DESC
  ), details AS MATERIALIZED (
    SELECT d."pricingModelVersion" AS model_version, d."productLineId" AS product_line_id,
      d.decision, d."conditionRateForecast" AS condition_rate
    FROM latest
    JOIN inventory_batch_results result USING (batch_number, sku)
    CROSS JOIN LATERAL jsonb_to_record(result.pricing_details_json) AS d(
      "pricingModelVersion" text, "productLineId" text, decision jsonb,
      "conditionRateForecast" jsonb)
  ), evidence AS (
    SELECT product_line_id::bigint AS product_line_id,
      CASE WHEN jsonb_typeof(decision->'qualifyingSalesCount') = 'number'
        AND jsonb_typeof(decision->'buyerIntervalDays') = 'number'
        THEN (decision->>'qualifyingSalesCount')::float8 END AS arrival_sales,
      CASE WHEN jsonb_typeof(decision->'qualifyingSalesCount') = 'number'
        AND jsonb_typeof(decision->'buyerIntervalDays') = 'number'
        THEN (decision->>'buyerIntervalDays')::float8 END AS arrival_interval,
      CASE WHEN jsonb_typeof(condition_rate->'transactions') = 'number'
        AND jsonb_typeof(condition_rate->'intervalDays') = 'number'
        THEN (condition_rate->>'transactions')::float8 END AS condition_sales,
      CASE WHEN jsonb_typeof(condition_rate->'transactions') = 'number'
        AND jsonb_typeof(condition_rate->'intervalDays') = 'number'
        THEN (condition_rate->>'intervalDays')::float8 END AS condition_interval
    FROM details
    WHERE model_version = $3 AND decision->>'basis' = 'modeled'
      AND product_line_id ~ '^[0-9]{1,18}$'
  )
  SELECT product_line_id,
    COALESCE(SUM(arrival_sales) FILTER (WHERE arrival_sales > 0 AND arrival_interval > 0), 0) AS arrival_sales,
    COALESCE(SUM(arrival_sales * arrival_interval) FILTER (WHERE arrival_sales > 0 AND arrival_interval > 0), 0) AS arrival_days,
    COALESCE(SUM(condition_sales) FILTER (WHERE condition_sales > 0 AND condition_interval > 0), 0) AS condition_sales,
    COALESCE(SUM(condition_sales * condition_interval) FILTER (WHERE condition_sales > 0 AND condition_interval > 0), 0) AS condition_days
  FROM evidence
  GROUP BY product_line_id
  ORDER BY product_line_id"#;

type Row = (i64, f64, f64, f64, f64);

/// The pools as of `now`, from results priced in the `POOL_DAYS` before it.
pub async fn load(db: impl sqlx::PgExecutor<'_>, now: DateTime<Utc>) -> sqlx::Result<Pools> {
    let rows: Vec<Row> = sqlx::query_as(POOLS)
        .bind(now - Duration::days(POOL_DAYS))
        .bind(now)
        .bind(MODEL_VERSION)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(line, arrival_sales, arrival_days, condition_sales, condition_days)| {
                let exposure = |sales, days| Exposure { sales, days };
                (
                    line,
                    Pool {
                        buyer_arrival: exposure(arrival_sales, arrival_days),
                        condition_rate: exposure(condition_sales, condition_days),
                    },
                )
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::database::Database;

    fn details(
        model: &str,
        basis: &str,
        sales: f64,
        interval: f64,
        condition: Option<Value>,
    ) -> Value {
        let mut details = json!({
            "pricingModelVersion": model,
            "productLineId": 990_001,
            "decision": { "basis": basis, "qualifyingSalesCount": sales, "buyerIntervalDays": interval },
        });
        if let Some(condition) = condition {
            details["conditionRateForecast"] = condition;
        }
        details
    }

    /// Results stored on the dev database in a transaction that is rolled back, priced in a
    /// future month no other result is in: each SKU's latest modeled result of the current model
    /// is pooled once, and older, other-model, unmodeled and out-of-window results are not.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_line_pools_each_skus_latest_modeled_result() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let now: DateTime<Utc> = "2099-01-31T00:00:00Z".parse().unwrap();
        let mut batches = Vec::new();
        for _ in 0..2 {
            let batch: i32 = sqlx::query_scalar(
                "INSERT INTO inventory_batches (source_label) VALUES ('rust-test') RETURNING batch_number",
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            batches.push(batch);
        }
        let condition =
            json!({ "transactions": 4, "intervalDays": 10, "method": "annual-buckets-v1" });
        let results = [
            // SKU 1, priced twice: only the later result counts.
            (
                batches[0],
                1,
                "2099-01-10",
                details(MODEL_VERSION, "modeled", 100.0, 1.0, None),
            ),
            (
                batches[1],
                1,
                "2099-01-20",
                details(MODEL_VERSION, "modeled", 2.0, 5.0, Some(condition)),
            ),
            (
                batches[0],
                2,
                "2099-01-15",
                details(MODEL_VERSION, "modeled", 3.0, 10.0, None),
            ),
            (
                batches[0],
                3,
                "2099-01-15",
                details("older-model", "modeled", 50.0, 1.0, None),
            ),
            (
                batches[0],
                4,
                "2099-01-15",
                details(MODEL_VERSION, "current-price", 50.0, 1.0, None),
            ),
            (
                batches[0],
                5,
                "2098-12-01",
                details(MODEL_VERSION, "modeled", 50.0, 1.0, None),
            ),
        ];
        for (batch, sku, day, details) in results {
            sqlx::query(
                "INSERT INTO inventory_batch_results
                   (batch_number, sku, result_status, row_json, priced_at, pricing_details_json)
                 VALUES ($1, $2, 'successful', '{}'::jsonb, $3::date::timestamptz, $4)",
            )
            .bind(batch)
            .bind(sku)
            .bind(day)
            .bind(sqlx::types::Json(details))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        let pools = load(&mut *tx, now).await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(
            pools,
            Pools::from([(
                990_001,
                Pool {
                    buyer_arrival: Exposure {
                        sales: 5.0,
                        days: 40.0
                    },
                    condition_rate: Exposure {
                        sales: 4.0,
                        days: 40.0
                    },
                },
            )])
        );
    }
}
