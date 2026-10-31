//! What a priced batch writes (`saveResults` and `refreshBatchCounts`), then what follows it in the
//! worker: the continuous inventory's last pricing (`recordBatchCompleted`), a retry after the
//! session lost its sales history (`retryBatchItemsAfter`), and the strategy's pricing curves
//! (`recordSuccessfulBatch`). Each call takes a connection, so the caller chooses the transaction.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

use super::job::{Mode, PricedSku};
use super::results;
use crate::features::{
    configuration::config::Config as StoredConfig, inventory_economics::ledger::proceeds::iso,
    inventory_strategy::collate,
};

/// Set when pricing had no sales history, market price, or listing to work from.
pub const NO_DATA_PAUSE_REASON: &str =
    "No usable sales history, market price, or listing to price this SKU.";

/// One SKU's saved result.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub sku: i32,
    pub result_status: &'static str,
    pub row: Value,
    pub details: Value,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// The rows a priced batch saves, priced at `priced_at`.
pub fn rows(
    skus: &[PricedSku],
    mode: Mode,
    priced_at: DateTime<Utc>,
    stored: &StoredConfig,
) -> Vec<Row> {
    let at = iso(priced_at);
    skus.iter()
        .map(|sku| Row {
            sku: sku.item.sku as i32,
            result_status: results::status(sku),
            row: results::row(sku),
            details: results::details(sku, mode, &at, stored),
            errors: sku.item.errors.clone(),
            warnings: sku.item.warnings.clone().unwrap_or_default(),
        })
        .collect()
}

/// Saves the batch's results, replacing its earlier ones unless only its errors were repriced,
/// and refreshes its counts and summary.
pub async fn save_results(
    conn: &mut PgConnection,
    batch_number: i32,
    mode: Mode,
    rows: &[Row],
    priced_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    if mode != Mode::Errors {
        sqlx::query("DELETE FROM inventory_batch_results WHERE batch_number = $1")
            .bind(batch_number)
            .execute(&mut *conn)
            .await?;
    }
    for row in rows {
        sqlx::query(
            "INSERT INTO inventory_batch_results (
                batch_number, sku, result_status, row_json, pricing_details_json,
                error_messages, warning_messages, priced_at
             ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7::text[], $8)
             ON CONFLICT (batch_number, sku) DO UPDATE SET
                result_status = EXCLUDED.result_status,
                row_json = EXCLUDED.row_json,
                pricing_details_json = EXCLUDED.pricing_details_json,
                error_messages = EXCLUDED.error_messages,
                warning_messages = EXCLUDED.warning_messages,
                priced_at = EXCLUDED.priced_at",
        )
        .bind(batch_number)
        .bind(row.sku)
        .bind(row.result_status)
        .bind(&row.row)
        .bind(&row.details)
        .bind(&row.errors)
        .bind(&row.warnings)
        .bind(priced_at)
        .execute(&mut *conn)
        .await?;
    }
    refresh_counts(conn, batch_number, now).await
}

/// A saved result as the batch summary reads it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Saved {
    pub result_status: String,
    pub row_json: Value,
    pub pricing_details_json: Option<Value>,
    pub error_messages: Vec<String>,
    pub warning_messages: Vec<String>,
}

/// `parseNumericValue`: a finite number, or a string's leading number, else zero.
fn numeric(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()).unwrap_or(0.0),
        Value::String(s) => parse_float(s).filter(|v| v.is_finite()).unwrap_or(0.0),
        _ => 0.0,
    }
}

/// `Number.parseFloat`: the longest leading decimal of the trimmed text.
pub fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_start();
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        from + bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let whole = digits(end);
    let mut fraction = whole;
    if bytes.get(whole) == Some(&b'.') {
        fraction = digits(whole + 1);
    }
    if fraction == end || (fraction == end + 1 && bytes.get(end) == Some(&b'.')) {
        return None;
    }
    end = fraction;
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = end + 1 + usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(sign);
        if exponent > sign {
            end = exponent;
        }
    }
    text[..end].parse().ok()
}

/// A detail's number when it has one; the row's text otherwise (`details?.x ?? parse(row[..])`).
fn figure(details: Option<&Value>, key: &str, row: &Value, column: &str) -> f64 {
    match details.and_then(|d| d.get(key)).filter(|v| !v.is_null()) {
        Some(v) => v.as_f64().unwrap_or(f64::NAN),
        None => numeric(&row[column]),
    }
}

/// `computeMedian`.
fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}

/// A number as JavaScript writes it into JSON.
fn js(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The batch's summary from its saved results (`buildBatchSummary`), `generatedAt` `now`.
pub fn batch_summary(
    batch_number: i32,
    total_rows: usize,
    saved: &[Saved],
    now: DateTime<Utc>,
) -> Value {
    let successful: Vec<&Saved> = saved
        .iter()
        .filter(|s| s.result_status == "successful")
        .collect();
    let mut totals_percentiles: Vec<(String, f64)> = Vec::new();
    let mut with_market_percentiles: Vec<(String, f64)> = Vec::new();
    let mut historical: Vec<(String, Vec<f64>)> = Vec::new();
    let mut adjusted: Vec<(String, Vec<f64>)> = Vec::new();
    let mut lines: HashMap<String, (usize, Vec<f64>, f64)> = HashMap::new();
    let (mut quantity_total, mut add_total) = (0.0, 0.0);
    let (mut market, mut low, mut marketplace) = (0.0, 0.0, 0.0);
    let (mut market_wm, mut low_wm, mut marketplace_wm, mut quantity_wm) = (0.0, 0.0, 0.0, 0.0);
    fn add(entries: &mut Vec<(String, f64)>, key: &str, value: f64) {
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some((_, total)) => *total += value,
            None => entries.push((key.into(), value)),
        }
    }
    fn push(entries: &mut Vec<(String, Vec<f64>)>, key: &str, value: f64) {
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some((_, values)) => values.push(value),
            None => entries.push((key.into(), vec![value])),
        }
    }
    for s in &successful {
        let d = s.pricing_details_json.as_ref();
        let row = &s.row_json;
        let quantity = figure(d, "quantity", row, "Total Quantity");
        let add_quantity = figure(d, "addToQuantity", row, "Add to Quantity");
        let combined = quantity + add_quantity;
        let tcg_market = figure(d, "tcgMarketPrice", row, "TCG Market Price");
        let lowest = figure(d, "lowestSalePrice", row, "Lowest Sale Price");
        let listed = figure(d, "marketplacePrice", row, "TCG Marketplace Price");
        let suggested = figure(d, "suggestedPrice", row, "Suggested Price");
        let line = row["Product Line"]
            .as_str()
            .filter(|l| !l.is_empty())
            .unwrap_or("Unknown");
        quantity_total += quantity;
        add_total += add_quantity;
        market += tcg_market * combined;
        low += lowest * combined;
        marketplace += listed * combined;
        if tcg_market > 0.0 {
            market_wm += tcg_market * combined;
            low_wm += lowest * combined;
            marketplace_wm += listed * combined;
            quantity_wm += combined;
        }
        let entry = lines
            .entry(line.to_string())
            .or_insert((0, Vec::new(), 0.0));
        entry.0 += 1;
        entry.2 += suggested * combined;
        let percentile_used = figure(d, "percentileUsed", row, "Percentile Used");
        if percentile_used > 0.0 && !entry.1.contains(&percentile_used) {
            entry.1.push(percentile_used);
        }
        for point in d
            .and_then(|d| d["percentiles"].as_array())
            .into_iter()
            .flatten()
        {
            let key = format!(
                "{}th",
                crate::features::inventory_economics::ledger::fingerprint::js_float(
                    point["percentile"].as_f64().unwrap_or(f64::NAN),
                )
            );
            let price = point["suggestedPrice"].as_f64().unwrap_or(f64::NAN);
            add(&mut totals_percentiles, &key, price * combined);
            if tcg_market > 0.0 {
                add(&mut with_market_percentiles, &key, price * combined);
            }
            if let Some(days) = point
                .get("historicalSalesVelocityDays")
                .filter(|v| !v.is_null())
            {
                push(&mut historical, &key, days.as_f64().unwrap_or(f64::NAN));
            }
            if let Some(days) = point
                .get("estimatedTimeToSellDays")
                .filter(|v| !v.is_null())
            {
                push(&mut adjusted, &key, days.as_f64().unwrap_or(f64::NAN));
            }
        }
    }
    let object = |entries: &[(String, f64)]| -> Value {
        Value::Object(entries.iter().map(|(k, v)| (k.clone(), js(*v))).collect())
    };
    let medians = |entries: &mut [(String, Vec<f64>)]| -> Value {
        Value::Object(
            entries
                .iter_mut()
                .filter_map(|(k, values)| median(values).map(|m| (k.clone(), js(m))))
                .collect(),
        )
    };
    let total = total_rows as f64;
    let mut summary = Map::new();
    summary.insert("totalRows".into(), json!(total_rows));
    summary.insert("processedRows".into(), json!(successful.len()));
    summary.insert(
        "manualReviewRows".into(),
        json!(saved.len() - successful.len()),
    );
    summary.insert(
        "skippedRows".into(),
        json!(total_rows.saturating_sub(saved.len())),
    );
    summary.insert(
        "errorRows".into(),
        json!(
            saved
                .iter()
                .filter(|s| !s.error_messages.is_empty())
                .count()
        ),
    );
    summary.insert(
        "warningRows".into(),
        json!(
            saved
                .iter()
                .filter(|s| !s.warning_messages.is_empty())
                .count()
        ),
    );
    summary.insert(
        "successRate".into(),
        js(if total_rows > 0 {
            successful.len() as f64 / total * 100.0
        } else {
            0.0
        }),
    );
    summary.insert("generatedAt".into(), json!(iso(now)));
    summary.insert(
        "fileName".into(),
        json!(format!("inventory-batch-{batch_number}")),
    );
    summary.insert("totalQuantity".into(), js(quantity_total));
    summary.insert("totalAddQuantity".into(), js(add_total));
    summary.insert(
        "totals".into(),
        json!({ "marketPrice": js(market), "lowPrice": js(low), "marketplacePrice": js(marketplace),
                "percentiles": object(&totals_percentiles) }),
    );
    summary.insert(
        "totalsWithMarket".into(),
        json!({ "marketPrice": js(market_wm), "lowPrice": js(low_wm), "marketplacePrice": js(marketplace_wm),
                "percentiles": object(&with_market_percentiles), "quantityWithMarket": js(quantity_wm) }),
    );
    summary.insert(
        "medianDaysToSell".into(),
        json!({ "historicalSalesVelocity": 0, "percentiles": medians(&mut historical),
                "marketAdjustedPercentiles": medians(&mut adjusted) }),
    );
    if !lines.is_empty() {
        let mut names: Vec<&String> = lines.keys().collect();
        names.sort_by(|a, b| collate::compare(a, b));
        let breakdown: Map<String, Value> = names
            .into_iter()
            .map(|name| {
                let (count, used, value) = &lines[name];
                let mut used = used.clone();
                used.sort_by(|a, b| a.total_cmp(b));
                let used: Vec<Value> = used.into_iter().map(js).collect();
                (
                    name.clone(),
                    json!({ "count": count, "percentilesUsed": used, "totalValue": js(*value) }),
                )
            })
            .collect();
        summary.insert("productLineBreakdown".into(), Value::Object(breakdown));
    }
    Value::Object(summary)
}

/// `refreshBatchCounts`: the batch priced, its summary and counts from its saved results.
pub async fn refresh_counts(
    conn: &mut PgConnection,
    batch_number: i32,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM inventory_batch_items WHERE batch_number = $1")
            .bind(batch_number)
            .fetch_one(&mut *conn)
            .await?;
    let saved: Vec<Saved> = sqlx::query_as(
        "SELECT result_status, row_json, pricing_details_json, error_messages, warning_messages
         FROM inventory_batch_results WHERE batch_number = $1",
    )
    .bind(batch_number)
    .fetch_all(&mut *conn)
    .await?;
    let summary = batch_summary(batch_number, total as usize, &saved, now);
    sqlx::query(
        "UPDATE inventory_batches
         SET status = 'priced', updated_at = NOW(),
             last_priced_at = (SELECT MAX(r.priced_at) FROM inventory_batch_results r WHERE r.batch_number = $1),
             summary_json = $2::jsonb, successful_count = $3, manual_review_count = $4
         WHERE batch_number = $1",
    )
    .bind(batch_number)
    .bind(&summary)
    .bind(summary["processedRows"].as_i64().unwrap_or(0) as i32)
    .bind(summary["manualReviewRows"].as_i64().unwrap_or(0) as i32)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `recordBatchCompleted`: each continuous SKU the batch priced takes its result.
pub async fn record_batch_completed(
    conn: &mut PgConnection,
    batch_number: i32,
) -> sqlx::Result<u64> {
    let done = sqlx::query(
        "UPDATE continuous_pricing_inventory inventory
         SET last_priced_at = result.priced_at,
             consecutive_pricing_failures = CASE
               WHEN result.result_status = 'successful' THEN 0
               ELSE consecutive_pricing_failures + 1
             END,
             pause_reason = CASE
               WHEN result.result_status <> 'successful' AND consecutive_pricing_failures + 1 >= 3
               THEN 'Repeated pricing failures require review.'
               WHEN result.result_status = 'successful'
                 AND result.pricing_details_json->'decision'->>'basis' = 'current-price'
                 AND pause_reason IS NULL
               THEN $2
               ELSE pause_reason
             END,
             next_price_at = CASE
               WHEN result.result_status <> 'successful'
                 AND cardinality(result.error_messages) > 0
                 AND consecutive_pricing_failures + 1 < 3
               THEN LEAST(next_price_at, NOW() + INTERVAL '15 minutes')
               ELSE next_price_at
             END,
             updated_at = NOW()
         FROM inventory_batch_results result
         WHERE inventory.last_batch_number = $1 AND result.batch_number = $1 AND result.sku = inventory.sku",
    )
    .bind(batch_number)
    .bind(NO_DATA_PAUSE_REASON)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

/// `retryBatchItemsAfter`: the batch's continuous SKUs priced again within `minutes`.
pub async fn retry_after(
    conn: &mut PgConnection,
    batch_number: i32,
    minutes: i32,
) -> sqlx::Result<u64> {
    let done = sqlx::query(
        "UPDATE continuous_pricing_inventory
         SET next_price_at = LEAST(next_price_at, NOW() + ($2 * INTERVAL '1 minute')), updated_at = NOW()
         WHERE last_batch_number = $1",
    )
    .bind(batch_number)
    .bind(f64::from(minutes))
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

/// `recordSuccessfulBatch`: a continuous or strategy batch's priced curves become the strategy's
/// latest for their seller, unless a newer one is already kept.
pub async fn record_successful_batch(
    conn: &mut PgConnection,
    batch_number: i32,
) -> sqlx::Result<u64> {
    let done = sqlx::query(
        "INSERT INTO inventory_strategy_pricing_curves (
            seller_key, sku, batch_number, pricing_details_json, priced_at, updated_at
         )
         SELECT batch.source_label, result.sku, result.batch_number, result.pricing_details_json,
                result.priced_at, NOW()
         FROM inventory_batch_results result
         JOIN inventory_batches batch ON batch.batch_number = result.batch_number
         WHERE result.batch_number = $1
           AND batch.source_type IN ('continuous', 'strategy')
           AND result.result_status = 'successful'
           AND result.pricing_details_json IS NOT NULL
           AND CASE
             WHEN jsonb_typeof(result.pricing_details_json->'percentiles') = 'array'
             THEN jsonb_array_length(result.pricing_details_json->'percentiles') > 0
             ELSE FALSE
           END
         ON CONFLICT (seller_key, sku) DO UPDATE SET
           batch_number = EXCLUDED.batch_number,
           pricing_details_json = EXCLUDED.pricing_details_json,
           priced_at = EXCLUDED.priced_at,
           updated_at = NOW()
         WHERE inventory_strategy_pricing_curves.priced_at <= EXCLUDED.priced_at",
    )
    .bind(batch_number)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// Equal but for the last bits of sums: Node sums the results in the order Postgres returns
    /// them (its query has no order), so the same rows can sum a last bit apart.
    fn close(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                x == y || (x - y).abs() <= 1e-12 * x.abs().max(y.abs())
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close(v, w)))
            }
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(v, w)| close(v, w))
            }
            _ => a == b,
        }
    }

    /// Every batch Node saved since September, its summary rebuilt from its results, against the
    /// summary Node stored (all but `generatedAt`). Reads the dev database only.
    #[tokio::test]
    #[ignore = "reads the dev database's batches"]
    async fn summaries_match_the_ones_node_stored() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let batches: Vec<(i32, Value, i64)> = sqlx::query_as(
            "SELECT b.batch_number, b.summary_json,
                    (SELECT COUNT(*) FROM inventory_batch_items i WHERE i.batch_number = b.batch_number)
             FROM inventory_batches b
             WHERE b.status = 'priced' AND b.summary_json ? 'generatedAt'
               AND b.last_priced_at > '2026-09-01'
             ORDER BY b.batch_number",
        )
        .fetch_all(&db.0)
        .await
        .unwrap();
        let (mut same, mut summed_apart, mut different) = (0, 0, Vec::new());
        for (batch, stored, total) in &batches {
            let saved: Vec<Saved> = sqlx::query_as(
                "SELECT result_status, row_json, pricing_details_json, error_messages, warning_messages
                 FROM inventory_batch_results WHERE batch_number = $1",
            )
            .bind(batch)
            .fetch_all(&db.0)
            .await
            .unwrap();
            let mut ours = batch_summary(*batch, *total as usize, &saved, Utc::now());
            let mut theirs = stored.clone();
            ours.as_object_mut().unwrap().remove("generatedAt");
            theirs.as_object_mut().unwrap().remove("generatedAt");
            if ours == theirs {
                same += 1;
            } else if close(&ours, &theirs) {
                summed_apart += 1;
            } else {
                different.push(*batch);
            }
        }
        println!(
            "{} batches: {same} same, {summed_apart} a last bit apart, {} different {:?}",
            batches.len(),
            different.len(),
            different.iter().take(10).collect::<Vec<_>>()
        );
        if let Some(batch) = different.first() {
            let (stored, total) = batches
                .iter()
                .find(|b| b.0 == *batch)
                .map(|b| (&b.1, b.2))
                .unwrap();
            let saved: Vec<Saved> = sqlx::query_as(
                "SELECT result_status, row_json, pricing_details_json, error_messages, warning_messages
                 FROM inventory_batch_results WHERE batch_number = $1",
            )
            .bind(batch)
            .fetch_all(&db.0)
            .await
            .unwrap();
            let ours = batch_summary(*batch, total as usize, &saved, Utc::now());
            for (key, value) in ours.as_object().unwrap() {
                if !stored.get(key).is_some_and(|s| close(s, value)) && key != "generatedAt" {
                    println!(
                        "  {batch}.{key}: rust {value} node {}",
                        stored.get(key).unwrap_or(&Value::Null)
                    );
                }
            }
        }
        assert!(different.is_empty());
    }

    /// A saved batch, saved again from its own rows inside a rolled-back transaction, keeps its
    /// counts; the follow-ups run against it.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn saving_a_batch_again_keeps_its_counts() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let batch: i32 = sqlx::query_scalar(
            "SELECT batch_number FROM inventory_batches WHERE source_type = 'continuous' AND status = 'priced'
             AND successful_count > 0 ORDER BY batch_number DESC LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let before: (i32, i32) = sqlx::query_as(
            "SELECT successful_count, manual_review_count FROM inventory_batches WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        type SavedRow = (i32, String, Value, Option<Value>, Vec<String>, Vec<String>);
        let rows: Vec<SavedRow> = sqlx::query_as(
            "SELECT sku, result_status, row_json, pricing_details_json, error_messages, warning_messages
             FROM inventory_batch_results WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let rows: Vec<Row> = rows
            .into_iter()
            .map(|(sku, status, row, details, errors, warnings)| Row {
                sku,
                result_status: if status == "successful" {
                    "successful"
                } else {
                    "manual_review"
                },
                row,
                details: details.unwrap_or(Value::Null),
                errors,
                warnings,
            })
            .collect();
        save_results(&mut tx, batch, Mode::Full, &rows, Utc::now(), Utc::now())
            .await
            .unwrap();
        let after: (i32, i32, String) = sqlx::query_as(
            "SELECT successful_count, manual_review_count, status FROM inventory_batches WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!((after.0, after.1), before);
        assert_eq!(after.2, "priced");
        record_batch_completed(&mut tx, batch).await.unwrap();
        retry_after(&mut tx, batch, 15).await.unwrap();
        let curves = record_successful_batch(&mut tx, batch).await.unwrap();
        println!(
            "batch {batch}: {} rows saved again, {curves} curves recorded",
            rows.len()
        );
        tx.rollback().await.unwrap();
    }

    #[test]
    fn numbers_parse_as_parse_float_does() {
        assert_eq!(numeric(&json!("1.25")), 1.25);
        assert_eq!(numeric(&json!(" 3 cards")), 3.0);
        assert_eq!(numeric(&json!("1e3x")), 1000.0);
        assert_eq!(numeric(&json!("2e")), 2.0);
        assert_eq!(numeric(&json!(".5")), 0.5);
        assert_eq!(numeric(&json!("-.")), 0.0);
        assert_eq!(numeric(&json!("")), 0.0);
        assert_eq!(numeric(&json!("abc")), 0.0);
        assert_eq!(numeric(&json!(2)), 2.0);
        assert_eq!(numeric(&Value::Null), 0.0);
    }

    #[test]
    fn medians_average_the_middle_pair() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [4.0, 1.0, 2.0, 3.0]), Some(2.5));
        assert_eq!(median(&mut []), None);
    }
}
