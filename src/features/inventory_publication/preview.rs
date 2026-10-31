//! Which of a batch's priced SKUs a publication would carry (`previewInventoryBatchPublication`):
//! each successful result with its price to the cent, its catalog names, its inventory change and
//! the reasons it is held back, if any.
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx::PgConnection;

use super::policy::{self, Basis, Candidate, Policy, Reason, Source};

/// The batch a preview reads.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Batch {
    pub batch_number: i32,
    pub source_type: String,
    pub source_label: String,
    pub manual_review_count: i32,
    /// The latest pricing job, and whether it completed.
    pub job_id: Option<i64>,
    pub job_status: Option<String>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Item {
    pub sku: i32,
    pub add_to_quantity: i32,
    pub current_price: Option<f64>,
    pub product_id: i32,
    pub original_row_json: Option<Value>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Result {
    pub sku: i32,
    pub row_json: Value,
    pub pricing_details_json: Option<Value>,
    pub error_messages: Vec<String>,
    pub warning_messages: Vec<String>,
    pub priced_at: DateTime<Utc>,
}

/// What earlier publications already hold: each inventory change's status, and the pricing
/// results already used.
#[derive(Clone, Debug, Default)]
pub struct Known {
    pub delta_statuses: HashMap<String, String>,
    pub used_candidates: HashSet<String>,
}

/// A SKU the publication would carry, or why not.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewItem {
    pub sku: i32,
    pub product_id: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub previous_price: Option<f64>,
    pub desired_price: Option<f64>,
    pub original_quantity_delta: i32,
    pub quantity_delta: i32,
    pub inventory_delta_already_planned: bool,
    pub priced_at: DateTime<Utc>,
    pub eligible: bool,
    pub reasons: Vec<Reason>,
    pub candidate_key: String,
    pub inventory_delta_key: Option<String>,
    pub forecast_evidence: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    pub batch_number: i32,
    pub pricing_job_id: i64,
    pub source: Source,
    pub source_label: String,
    pub eligible_count: usize,
    pub excluded_count: usize,
    pub items: Vec<PreviewItem>,
}

/// `parsePrice`: a finite number, or a string's leading number; none otherwise.
fn price(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) if !s.trim().is_empty() => {
            crate::js_number::parse_float(s).filter(|v| v.is_finite())
        }
        _ => None,
    }
}

fn text(row: &Value, column: &str) -> String {
    row[column]
        .as_str()
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// `buildPublicationCondition`: the condition, with the variant unless it is Normal or already
/// in the condition.
pub fn condition(row: &Value) -> String {
    let condition = text(row, "Sku Condition");
    let variant = text(row, "Sku Variant");
    if condition.is_empty()
        || variant.is_empty()
        || variant.to_lowercase() == "normal"
        || condition.to_lowercase().contains(&variant.to_lowercase())
    {
        condition
    } else {
        format!("{condition} {variant}")
    }
}

/// `snapshotPublicationForecastEvidence`: what the price was decided from, kept with the item.
pub fn forecast_evidence(details: Option<&Value>) -> Option<Value> {
    let details = details?.as_object()?;
    let mut evidence = Map::new();
    evidence.insert("source".into(), "publication_candidate".into());
    evidence.insert(
        "schemaVersion".into(),
        details.get("schemaVersion").cloned().unwrap_or(Value::Null),
    );
    evidence.insert(
        "pricedAt".into(),
        details.get("pricedAt").cloned().unwrap_or(Value::Null),
    );
    if let Some(version) = details
        .get("pricingModelVersion")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        evidence.insert("pricingModelVersion".into(), version.clone());
    }
    for key in [
        "policy",
        "decision",
        "buyerChoiceForecast",
        "conditionRateForecast",
    ] {
        if let Some(value) = details.get(key).filter(|v| v.is_object()) {
            evidence.insert(key.into(), value.clone());
        }
    }
    if let Some(days) = details.get("estimatedTimeToSellDays") {
        evidence.insert("estimatedTimeToSellDays".into(), days.clone());
    }
    Some(Value::Object(evidence))
}

/// The preview of `batch`, from its items, its successful results and what earlier publications
/// hold, at `now`.
pub fn preview(
    batch: &Batch,
    items: &[Item],
    results: &[Result],
    known: &Known,
    policy: &Policy,
    now: DateTime<Utc>,
    automatic: bool,
) -> std::result::Result<Preview, String> {
    let number = batch.batch_number;
    if batch.source_type == "strategy" {
        return Err(format!(
            "Batch {number} is an analysis-only strategy batch and cannot be published."
        ));
    }
    let source = Source::of(&batch.source_type)
        .ok_or_else(|| format!("Batch {number} has an unknown source."))?;
    let pricing_job_id = match (batch.job_id, batch.job_status.as_deref()) {
        (Some(id), Some("completed")) => id,
        _ => {
            return Err(format!(
                "Batch {number} does not have a completed pricing job."
            ));
        }
    };
    let by_sku: HashMap<i32, &Item> = items.iter().map(|i| (i.sku, i)).collect();
    let preview_items: Vec<PreviewItem> = results
        .iter()
        .map(|result| {
            let candidate_key = policy::candidate_key(number, result.sku, result.priced_at);
            let item = by_sku.get(&result.sku).copied();
            let original = item.map_or(0, |i| i.add_to_quantity);
            let possible_key =
                (original != 0).then(|| policy::inventory_delta_key(number, result.sku));
            let status = possible_key
                .as_ref()
                .and_then(|k| known.delta_statuses.get(k))
                .map(String::as_str);
            let already_planned = status.is_some();
            let quantity_delta = if status == Some("published") {
                0
            } else {
                original
            };
            let inventory_delta_key =
                possible_key.filter(|_| quantity_delta != 0 && !already_planned);
            let details = result.pricing_details_json.as_ref();
            let detail = |key: &str| details.and_then(|d| d.get(key)).filter(|v| !v.is_null());
            let listed = match detail("marketplacePrice") {
                Some(v) => v.as_f64(),
                None => price(&result.row_json["TCG Marketplace Price"]),
            };
            let previous_price = match detail("previousPrice") {
                Some(v) => v.as_f64(),
                None => {
                    price(&result.row_json["Previous Price"]).or(item.and_then(|i| i.current_price))
                }
            };
            let catalog = item
                .and_then(|i| i.original_row_json.as_ref())
                .filter(|r| !r.is_null())
                .unwrap_or(&result.row_json);
            let product_line = text(catalog, "Product Line");
            let set_name = text(catalog, "Set Name");
            let product_name = text(catalog, "Product");
            let condition = condition(catalog);
            let decision = policy::evaluate(
                &Candidate {
                    source,
                    batch_number: number,
                    sku: result.sku,
                    price: listed,
                    previous_price,
                    quantity_delta: f64::from(quantity_delta),
                    inventory_delta_consumed: false,
                    is_new_inventory: original != 0,
                    priced_at: result.priced_at,
                    errors: result.error_messages.clone(),
                    warnings: result.warning_messages.clone(),
                    decision: detail("decision").and_then(Basis::of),
                    market_price: detail("tcgMarketPrice").and_then(Value::as_f64),
                },
                policy,
                now,
                automatic,
            );
            let mut reasons = decision.reasons;
            if item.is_none_or(|i| i.product_id <= 0)
                || product_line.is_empty()
                || set_name.is_empty()
                || product_name.is_empty()
                || condition.is_empty()
            {
                policy::add(&mut reasons, Reason::MissingProductMetadata);
            }
            if known.used_candidates.contains(&candidate_key) {
                policy::add(&mut reasons, Reason::PricingCandidateAlreadyUsed);
            }
            if source == Source::Csv && quantity_delta != 0 {
                policy::add(&mut reasons, Reason::CsvQuantityDeltaRequiresReview);
            }
            match status {
                Some("ambiguous") => policy::add(&mut reasons, Reason::InventoryDeltaAmbiguous),
                Some(s) if s != "published" => {
                    policy::add(&mut reasons, Reason::InventoryDeltaAlreadyPlanned)
                }
                _ => {}
            }
            PreviewItem {
                sku: result.sku,
                product_id: item.map_or(0, |i| i.product_id),
                product_line,
                set_name,
                product_name,
                condition,
                previous_price,
                desired_price: decision.rounded_price,
                original_quantity_delta: original,
                quantity_delta,
                inventory_delta_already_planned: already_planned,
                priced_at: result.priced_at,
                eligible: reasons.is_empty(),
                reasons,
                candidate_key,
                inventory_delta_key,
                forecast_evidence: forecast_evidence(details),
            }
        })
        .collect();
    let eligible_count = preview_items.iter().filter(|i| i.eligible).count();
    Ok(Preview {
        batch_number: number,
        pricing_job_id,
        source,
        source_label: batch.source_label.clone(),
        eligible_count,
        excluded_count: preview_items.len() - eligible_count
            + batch.manual_review_count.max(0) as usize,
        items: preview_items,
    })
}

/// The batch, its latest pricing job, its items and its successful results.
pub async fn load(
    conn: &mut PgConnection,
    batch_number: i32,
) -> sqlx::Result<Option<(Batch, Vec<Item>, Vec<Result>)>> {
    let batch: Option<Batch> = sqlx::query_as(
        "SELECT b.batch_number, b.source_type, b.source_label, b.manual_review_count,
                job.id AS job_id, job.status AS job_status
         FROM inventory_batches b
         LEFT JOIN LATERAL (
           SELECT id, status FROM inventory_batch_pricing_jobs
           WHERE batch_number = b.batch_number ORDER BY created_at DESC, id DESC LIMIT 1
         ) job ON TRUE
         WHERE b.batch_number = $1",
    )
    .bind(batch_number)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(batch) = batch else {
        return Ok(None);
    };
    let items: Vec<Item> = sqlx::query_as(
        "SELECT sku, add_to_quantity, current_price::float8 AS current_price, product_id, original_row_json
         FROM inventory_batch_items WHERE batch_number = $1 ORDER BY created_at, sku",
    )
    .bind(batch_number)
    .fetch_all(&mut *conn)
    .await?;
    let results: Vec<Result> = sqlx::query_as(
        "SELECT r.sku, r.row_json, r.pricing_details_json, r.error_messages, r.warning_messages, r.priced_at
         FROM inventory_batch_results r
         WHERE r.batch_number = $1 AND r.result_status = 'successful'
         ORDER BY COALESCE(r.row_json->>'Product Line', ''), COALESCE(r.row_json->>'Set Name', ''),
                  COALESCE(r.row_json->>'Product', ''), r.sku",
    )
    .bind(batch_number)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Some((batch, items, results)))
}

/// What publications before `before` (all, when none) hold of these items.
pub async fn known(
    conn: &mut PgConnection,
    batch_number: i32,
    items: &[Item],
    results: &[Result],
    before: Option<i64>,
) -> sqlx::Result<Known> {
    let deltas: Vec<String> = items
        .iter()
        .filter(|i| i.add_to_quantity != 0)
        .map(|i| policy::inventory_delta_key(batch_number, i.sku))
        .collect();
    let candidates: Vec<String> = results
        .iter()
        .map(|r| policy::candidate_key(batch_number, r.sku, r.priced_at))
        .collect();
    let bound = before.unwrap_or(i64::MAX);
    let delta_statuses: Vec<(String, String)> = sqlx::query_as(
        "SELECT inventory_delta_key, status FROM inventory_publication_items
         WHERE inventory_delta_key = ANY($1) AND publication_id < $2",
    )
    .bind(&deltas)
    .bind(bound)
    .fetch_all(&mut *conn)
    .await?;
    let used: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT candidate_key FROM inventory_publication_items
         WHERE candidate_key = ANY($1) AND publication_id < $2",
    )
    .bind(&candidates)
    .bind(bound)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Known {
        delta_statuses: delta_statuses.into_iter().collect(),
        used_candidates: used.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::database::Database;

    /// An item as a publication holds it.
    #[derive(Debug, PartialEq, sqlx::FromRow)]
    struct Planned {
        candidate_key: String,
        inventory_delta_key: Option<String>,
        sku: i32,
        product_id: i32,
        product_line: String,
        set_name: String,
        product_name: String,
        condition: String,
        previous_price: Option<f64>,
        desired_price: f64,
        quantity_delta: i32,
        priced_at: DateTime<Utc>,
        forecast_evidence: Option<Value>,
    }

    #[test]
    fn conditions_carry_the_variant_unless_normal_or_already_named() {
        let row = |c: &str, v: &str| json!({ "Sku Condition": c, "Sku Variant": v });
        assert_eq!(
            condition(&row("Near Mint", "Holofoil")),
            "Near Mint Holofoil"
        );
        assert_eq!(condition(&row("Near Mint", "Normal")), "Near Mint");
        assert_eq!(condition(&row("Near Mint Foil", "foil")), "Near Mint Foil");
        assert_eq!(condition(&row(" Near Mint ", "")), "Near Mint");
    }

    /// Every automatic publication Node planned since its rules last changed, its batch previewed again as it stood (only the
    /// publications before it counted, `now` its creation): the eligible SKUs must be the items
    /// Node planned, with the same prices, names, keys and evidence. Reads the dev database only.
    #[tokio::test]
    #[ignore = "reads the dev database's publications"]
    async fn previews_plan_what_node_planned() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let publications: Vec<(i64, i32, Value, DateTime<Utc>)> = sqlx::query_as(
            "SELECT p.id, p.batch_number, p.config_json, p.created_at FROM inventory_publications p
             WHERE p.config_json->>'mode' = 'automatic' AND p.batch_number IS NOT NULL
               -- Planned by the code ported here (905b5ea30, the last change to the rules).
               AND p.created_at >= '2026-09-26T17:00:07Z'
             ORDER BY p.id",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let (mut same, mut different, mut skipped) = (0, Vec::new(), 0);
        for (id, batch_number, config, created_at) in &publications {
            let Some((batch, items, results)) = load(&mut conn, *batch_number).await.unwrap()
            else {
                skipped += 1;
                continue;
            };
            // A batch priced again after this publication no longer holds what it was planned from.
            if results.iter().any(|r| r.priced_at > *created_at) {
                skipped += 1;
                continue;
            }
            let known = known(&mut conn, *batch_number, &items, &results, Some(*id))
                .await
                .unwrap();
            let policy = Policy::of(&config["policy"]);
            let ours = match preview(&batch, &items, &results, &known, &policy, *created_at, true) {
                Ok(p) => p,
                Err(why) => {
                    different.push((*id, why));
                    continue;
                }
            };
            let planned: Vec<Planned> = sqlx::query_as(
                "SELECT candidate_key, inventory_delta_key, sku, product_id, product_line, set_name, product_name,
                        condition, previous_price::float8 AS previous_price, desired_price::float8 AS desired_price,
                        quantity_delta, priced_at,
                        forecast_evidence
                 FROM inventory_publication_items WHERE publication_id = $1 ORDER BY id",
            )
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .unwrap();
            let mine: Vec<Planned> = ours
                .items
                .iter()
                .filter(|i| i.eligible)
                .map(|i| Planned {
                    candidate_key: i.candidate_key.clone(),
                    inventory_delta_key: i.inventory_delta_key.clone(),
                    sku: i.sku,
                    product_id: i.product_id,
                    product_line: i.product_line.clone(),
                    set_name: i.set_name.clone(),
                    product_name: i.product_name.clone(),
                    condition: i.condition.clone(),
                    previous_price: i.previous_price.map(policy::round_to_cents),
                    desired_price: i.desired_price.unwrap_or(f64::NAN),
                    quantity_delta: i.quantity_delta,
                    priced_at: i.priced_at,
                    forecast_evidence: i.forecast_evidence.clone(),
                })
                .collect();
            let sorted = |mut v: Vec<Planned>| {
                v.sort_by_key(|p| p.sku);
                v
            };
            let (mine, planned) = (sorted(mine), sorted(planned));
            if mine == planned {
                same += 1;
            } else {
                let detail = if mine.len() != planned.len() {
                    let theirs: HashSet<i32> = planned.iter().map(|p| p.sku).collect();
                    let extra: Vec<String> = ours
                        .items
                        .iter()
                        .filter(|i| i.eligible && !theirs.contains(&i.sku))
                        .take(2)
                        .map(|i| {
                            let r = results.iter().find(|r| r.sku == i.sku).unwrap();
                            format!(
                                "sku {} price {:?} prev {:?} warnings {:?} decision {}",
                                i.sku,
                                i.desired_price,
                                i.previous_price,
                                r.warning_messages,
                                r.pricing_details_json
                                    .as_ref()
                                    .map_or(Value::Null, |d| d["decision"].clone())
                            )
                        })
                        .collect();
                    format!(
                        "{created_at} rust {} items, node {}; extra: {extra:?}",
                        mine.len(),
                        planned.len()
                    )
                } else {
                    let (r, n) = mine.iter().zip(&planned).find(|(r, n)| r != n).unwrap();
                    format!("rust {r:?}\n      node {n:?}")
                };
                different.push((*id, detail));
            }
        }
        println!(
            "{} automatic publications: {same} same, {} different, {skipped} not comparable",
            publications.len(),
            different.len()
        );
        let last = different.len().saturating_sub(3);
        for (id, why) in different.iter().take(3).chain(different.iter().skip(last)) {
            println!("  publication {id}: {why}");
        }
        assert!(different.is_empty());
    }
}
