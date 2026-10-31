//! The publication a priced batch plans (`planInventoryBatchPublication`), saved once per
//! planning key (`createOrFindPlanned`), and the plan a batch makes by itself when the settings
//! publish its source (`planAutomaticInventoryBatchPublication`).
//!
//! Planning again finds the publication already planned, and refuses one planned from different
//! inputs, so the pricing worker can plan after every job without planning twice.
use std::fmt;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, QueryBuilder};

use super::{
    policy::{Policy, Source},
    preview::{self, Preview, PreviewItem},
};
use crate::features::configuration::config::Config;

/// The only method a batch plans: staged quantity deltas, prices with them.
pub const METHOD: &str = "staged_delta";

#[derive(Debug)]
pub enum Error {
    /// The plan cannot be made as asked; the message says why, as Node's does.
    Rejected(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Error::Database(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Rejected(why) => f.write_str(why),
            Error::Database(error) => write!(f, "{error}"),
        }
    }
}

fn rejected<T>(why: impl Into<String>) -> Result<T, Error> {
    Err(Error::Rejected(why.into()))
}

/// Who asked for the plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Manual,
    Automatic,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Manual => "manual",
            Mode::Automatic => "automatic",
        }
    }
}

/// The SKUs a person chose, each once and in order; none means every eligible SKU
/// (`normalizeSelectedSkus`).
pub fn selected_skus(skus: Option<&[i64]>) -> Result<Option<Vec<i32>>, Error> {
    let Some(skus) = skus else { return Ok(None) };
    let valid: Option<Vec<i32>> = skus
        .iter()
        .map(|sku| i32::try_from(*sku).ok().filter(|sku| *sku > 0))
        .collect();
    match valid {
        Some(mut valid) if !valid.is_empty() => {
            valid.sort_unstable();
            valid.dedup();
            Ok(Some(valid))
        }
        _ => rejected("Select at least one valid SKU for publication."),
    }
}

/// The key a plan is saved under: one per pricing job, and one per selection within it
/// (`createSelectedPlanningKey`).
pub fn planning_key(pricing_job_id: i64, selected: Option<&[i32]>) -> String {
    let base = format!("inventory-batch-pricing-job:{pricing_job_id}");
    let Some(selected) = selected else {
        return base;
    };
    let joined: Vec<String> = selected.iter().map(i32::to_string).collect();
    let hash = Sha256::digest(joined.join(",").as_bytes());
    let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{base}:selection:{hex}")
}

/// The eligible items with a price, those selected when a selection is given; an error names a
/// selected SKU that is missing or ineligible (`selectPublishableItems`).
pub fn publishable<'a>(
    preview: &'a Preview,
    selected: Option<&[i32]>,
) -> Result<Vec<&'a PreviewItem>, Error> {
    let eligible: Vec<&PreviewItem> = preview
        .items
        .iter()
        .filter(|item| item.eligible && item.desired_price.is_some())
        .filter(|item| selected.is_none_or(|skus| skus.contains(&item.sku)))
        .collect();
    if let Some(skus) = selected {
        let missing: Vec<String> = skus
            .iter()
            .filter(|sku| !eligible.iter().any(|item| item.sku == **sku))
            .map(i32::to_string)
            .collect();
        if !missing.is_empty() {
            return rejected(format!(
                "Selected SKUs are missing or ineligible: {}.",
                missing.join(", ")
            ));
        }
    }
    if eligible.is_empty() {
        return rejected(format!(
            "Batch {} has no pricing results eligible for publication.",
            preview.batch_number
        ));
    }
    Ok(eligible)
}

/// A SKU a publication will publish.
#[derive(Clone, Debug, PartialEq)]
pub struct NewItem {
    pub candidate_key: String,
    pub inventory_delta_key: Option<String>,
    pub batch_number: i32,
    pub sku: i32,
    pub product_id: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub previous_price: Option<f64>,
    pub desired_price: f64,
    pub quantity_delta: i32,
    /// To the millisecond, as Node reads and writes it.
    pub priced_at: DateTime<Utc>,
    pub forecast_evidence: Option<Value>,
}

/// A publication to plan (`CreateInventoryPublication`).
#[derive(Clone, Debug, PartialEq)]
pub struct NewPublication {
    pub planning_key: String,
    pub batch_number: i32,
    pub pricing_job_id: i64,
    pub source: Source,
    pub seller_key: Option<String>,
    pub config: Value,
    pub items: Vec<NewItem>,
}

fn to_millis(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(at.timestamp_millis()).expect("a time already in range")
}

fn non_empty(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The publication `items` of `preview` make (`createPublicationParams`): a seller's or
/// continuous batch publishes to its own seller, received inventory to `target_seller`.
pub fn new_publication(
    preview: &Preview,
    policy: &Policy,
    mode: Mode,
    items: &[&PreviewItem],
    selected: Option<&[i32]>,
    target_seller: Option<&str>,
) -> Result<NewPublication, Error> {
    let target_seller = non_empty(target_seller);
    let receives = items.iter().any(|item| item.quantity_delta > 0);
    if preview.source == Source::PendingInventory && receives && target_seller.is_none() {
        return rejected("Select a target seller before publishing received inventory.");
    }
    Ok(NewPublication {
        planning_key: planning_key(preview.pricing_job_id, selected),
        batch_number: preview.batch_number,
        pricing_job_id: preview.pricing_job_id,
        source: preview.source,
        seller_key: match preview.source {
            Source::Seller | Source::Continuous => Some(preview.source_label.clone()),
            Source::PendingInventory => target_seller,
            Source::Csv => None,
        },
        config: json!({
            "policy": policy.document(),
            "mode": mode.as_str(),
            "selectedSkus": selected,
        }),
        items: items
            .iter()
            .map(|item| NewItem {
                candidate_key: item.candidate_key.clone(),
                inventory_delta_key: item.inventory_delta_key.clone(),
                batch_number: preview.batch_number,
                sku: item.sku,
                product_id: item.product_id,
                product_line: item.product_line.clone(),
                set_name: item.set_name.clone(),
                product_name: item.product_name.clone(),
                condition: item.condition.clone(),
                previous_price: item.previous_price,
                desired_price: item.desired_price.expect("publishable items have a price"),
                quantity_delta: item.quantity_delta,
                priced_at: to_millis(item.priced_at),
                forecast_evidence: item.forecast_evidence.clone(),
            })
            .collect(),
    })
}

/// What the database would refuse, refused first with Node's words (`validateCreateParams`).
pub fn validate(publication: &NewPublication) -> Result<(), Error> {
    if publication.planning_key.trim().is_empty() {
        return rejected("planningKey must not be empty.");
    }
    if publication.items.is_empty() {
        return rejected("items must contain at least one publication item.");
    }
    let receives = publication.items.iter().any(|item| item.quantity_delta > 0);
    if publication.source == Source::PendingInventory
        && receives
        && non_empty(publication.seller_key.as_deref()).is_none()
    {
        return rejected("sellerKey is required for received inventory publication.");
    }
    for (index, item) in publication.items.iter().enumerate() {
        let prefix = format!("items[{index}]");
        for (text, name) in [
            (&item.candidate_key, "candidateKey"),
            (&item.product_line, "productLine"),
            (&item.set_name, "setName"),
            (&item.product_name, "productName"),
            (&item.condition, "condition"),
        ] {
            if text.trim().is_empty() {
                return rejected(format!("{prefix}.{name} must not be empty."));
            }
        }
        if item.sku <= 0 {
            return rejected(format!("{prefix}.sku must be a positive integer."));
        }
        if item.product_id <= 0 {
            return rejected(format!("{prefix}.productId must be a positive integer."));
        }
        if !item.desired_price.is_finite() || item.desired_price <= 0.0 {
            return rejected(format!("{prefix}.desiredPrice must be positive."));
        }
        if item
            .forecast_evidence
            .as_ref()
            .is_some_and(|evidence| evidence["source"] != "publication_candidate")
        {
            return rejected(format!(
                "{prefix}.forecastEvidence must come from the publication candidate."
            ));
        }
        let delta_key = non_empty(item.inventory_delta_key.as_deref());
        if item.quantity_delta == 0 && delta_key.is_some() {
            return rejected(format!(
                "{prefix}.inventoryDeltaKey must be empty for a zero quantity delta."
            ));
        }
        if item.quantity_delta != 0 && delta_key.is_none() {
            return rejected(format!(
                "{prefix}.inventoryDeltaKey is required for a non-zero quantity delta."
            ));
        }
    }
    Ok(())
}

/// What makes two plans the same plan (`plannedPublicationIdentity`): every column the items
/// are written with, the prices as the database keeps them and the times to the millisecond.
#[derive(Clone, Debug, sqlx::FromRow)]
struct IdentityItem {
    candidate_key: String,
    inventory_delta_key: Option<String>,
    batch_number: Option<i32>,
    sku: i32,
    product_id: i32,
    product_line: String,
    set_name: String,
    product_name: String,
    condition: String,
    previous_price: Option<f64>,
    desired_price: f64,
    quantity_delta: i32,
    observed_quantity: Option<i32>,
    desired_absolute_quantity: Option<i32>,
    priced_at: DateTime<Utc>,
    eligibility_reasons: Vec<String>,
    forecast_evidence: Option<Value>,
}

impl IdentityItem {
    fn same(&self, other: &IdentityItem) -> bool {
        self.candidate_key == other.candidate_key
            && self.inventory_delta_key == other.inventory_delta_key
            && self.batch_number == other.batch_number
            && self.sku == other.sku
            && self.product_id == other.product_id
            && self.product_line == other.product_line
            && self.set_name == other.set_name
            && self.product_name == other.product_name
            && self.condition == other.condition
            && self.previous_price == other.previous_price
            && self.desired_price == other.desired_price
            && self.quantity_delta == other.quantity_delta
            && self.observed_quantity == other.observed_quantity
            && self.desired_absolute_quantity == other.desired_absolute_quantity
            && self.priced_at.timestamp_millis() == other.priced_at.timestamp_millis()
            && self.eligibility_reasons == other.eligibility_reasons
            && same_json(
                self.forecast_evidence.as_ref().unwrap_or(&Value::Null),
                other.forecast_evidence.as_ref().unwrap_or(&Value::Null),
            )
    }
}

/// JSON equal as `canonicalJson` writes it: keys in any order, and `1` the same number as `1.0`.
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(l), Value::Number(r)) => l.as_f64() == r.as_f64(),
        (Value::Array(l), Value::Array(r)) => {
            l.len() == r.len() && l.iter().zip(r).all(|(l, r)| same_json(l, r))
        }
        (Value::Object(l), Value::Object(r)) => {
            l.len() == r.len()
                && l.iter()
                    .all(|(key, value)| r.get(key).is_some_and(|other| same_json(value, other)))
        }
        _ => left == right,
    }
}

#[derive(sqlx::FromRow)]
struct Existing {
    id: i64,
    batch_number: Option<i32>,
    pricing_job_id: Option<i64>,
    method: String,
    source_type: String,
    seller_key: Option<String>,
}

/// Whether the publication already saved is the one asked for.
async fn same_plan(
    conn: &mut PgConnection,
    existing: &Existing,
    asked: &NewPublication,
) -> sqlx::Result<bool> {
    let saved: Vec<IdentityItem> = sqlx::query_as(
        "SELECT candidate_key, inventory_delta_key, batch_number, sku, product_id, product_line,
                set_name, product_name, condition, previous_price::float8 AS previous_price,
                desired_price::float8 AS desired_price, quantity_delta, observed_quantity,
                desired_absolute_quantity, priced_at, eligibility_reasons,
                -- Evidence a later backfill matched from history is not part of the plan.
                CASE WHEN forecast_evidence->>'source' = 'historical_pricing_result_exact_match'
                     THEN NULL ELSE forecast_evidence END AS forecast_evidence
         FROM inventory_publication_items WHERE publication_id = $1 ORDER BY id",
    )
    .bind(existing.id)
    .fetch_all(&mut *conn)
    .await?;
    let asked_items = asked.items.iter().map(|item| IdentityItem {
        candidate_key: item.candidate_key.clone(),
        inventory_delta_key: non_empty(item.inventory_delta_key.as_deref()),
        batch_number: Some(item.batch_number),
        sku: item.sku,
        product_id: item.product_id,
        product_line: item.product_line.clone(),
        set_name: item.set_name.clone(),
        product_name: item.product_name.clone(),
        condition: item.condition.clone(),
        previous_price: item.previous_price,
        desired_price: item.desired_price,
        quantity_delta: item.quantity_delta,
        observed_quantity: None,
        desired_absolute_quantity: None,
        priced_at: item.priced_at,
        eligibility_reasons: Vec::new(),
        forecast_evidence: item.forecast_evidence.clone(),
    });
    Ok(existing.batch_number == Some(asked.batch_number)
        && existing.pricing_job_id == Some(asked.pricing_job_id)
        && existing.method == METHOD
        && existing.source_type == asked.source.as_str()
        && existing.seller_key == non_empty(asked.seller_key.as_deref())
        && saved.len() == asked.items.len()
        && saved
            .iter()
            .zip(asked_items)
            .all(|(saved, asked)| saved.same(&asked)))
}

/// Saves `publication` as planned, or finds the one saved under its planning key: its id, and
/// whether this call made it. One saved from different inputs is refused. Run it in a
/// transaction: the publication, its items and their receipt links are saved together.
pub async fn create_or_find(
    conn: &mut PgConnection,
    publication: &NewPublication,
) -> Result<(i64, bool), Error> {
    validate(publication)?;
    let seller_key = non_empty(publication.seller_key.as_deref());
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO inventory_publications
           (planning_key, batch_number, pricing_job_id, method, source_type, seller_key, status, config_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7)
         ON CONFLICT (planning_key) DO NOTHING
         RETURNING id",
    )
    .bind(&publication.planning_key)
    .bind(publication.batch_number)
    .bind(publication.pricing_job_id)
    .bind(METHOD)
    .bind(publication.source.as_str())
    .bind(&seller_key)
    .bind(&publication.config)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(id) = inserted else {
        let existing: Option<Existing> = sqlx::query_as(
            "SELECT id, batch_number, pricing_job_id, method, source_type, seller_key
             FROM inventory_publications WHERE planning_key = $1",
        )
        .bind(&publication.planning_key)
        .fetch_optional(&mut *conn)
        .await?;
        let key = &publication.planning_key;
        let Some(existing) = existing else {
            return rejected(format!(
                "Inventory publication {key} could not be reloaded."
            ));
        };
        if !same_plan(conn, &existing, publication).await? {
            return rejected(format!(
                "Inventory publication {key} already exists with different planning inputs."
            ));
        }
        return Ok((existing.id, false));
    };
    let mut insert = QueryBuilder::new(
        "INSERT INTO inventory_publication_items (publication_id, candidate_key, inventory_delta_key,
           batch_number, sku, product_id, product_line, set_name, product_name, condition,
           previous_price, desired_price, quantity_delta, priced_at, eligibility_reasons,
           forecast_evidence, forecast_evidence_provenance, status) ",
    );
    insert.push_values(&publication.items, |mut row, item| {
        row.push_bind(id)
            .push_bind(&item.candidate_key)
            .push_bind(non_empty(item.inventory_delta_key.as_deref()))
            .push_bind(item.batch_number)
            .push_bind(item.sku)
            .push_bind(item.product_id)
            .push_bind(&item.product_line)
            .push_bind(&item.set_name)
            .push_bind(&item.product_name)
            .push_bind(&item.condition)
            // As node-postgres sends a number: its shortest text, rounded by the column.
            .push_bind(item.previous_price.map(|price| price.to_string()))
            .push_unseparated("::numeric")
            .push_bind(item.desired_price.to_string())
            .push_unseparated("::numeric")
            .push_bind(item.quantity_delta)
            .push_bind(item.priced_at)
            .push_bind(Vec::<String>::new())
            .push_bind(&item.forecast_evidence)
            .push_bind(if item.forecast_evidence.is_some() {
                "recorded"
            } else {
                "unknown"
            })
            .push_bind("planned");
    });
    insert.build().execute(&mut *conn).await?;
    if let (Source::PendingInventory, Some(seller), true) = (
        publication.source,
        &seller_key,
        publication.items.iter().any(|item| item.quantity_delta > 0),
    ) {
        link_receipts(conn, id, seller).await?;
    }
    Ok((id, true))
}

/// Ties each received SKU to the receipt lots its batch holds, for the seller it goes to; the
/// lots must add up to what the SKU publishes (`linkPendingInventoryReceipts`).
async fn link_receipts(
    conn: &mut PgConnection,
    publication_id: i64,
    seller: &str,
) -> Result<(), Error> {
    let items: Vec<(i64, Option<i32>, i32, i32)> = sqlx::query_as(
        "SELECT id, batch_number, sku, quantity_delta FROM inventory_publication_items
         WHERE publication_id = $1 AND quantity_delta > 0",
    )
    .bind(publication_id)
    .fetch_all(&mut *conn)
    .await?;
    for (item_id, batch_number, sku, quantity_delta) in items {
        let Some(batch_number) = batch_number else {
            return rejected(format!(
                "Publication item {item_id} cannot link receipts without a batch."
            ));
        };
        let (linked, other_sellers): (i32, i32) = sqlx::query_as(
            "SELECT COALESCE(SUM(link.linked_quantity), 0)::int,
                    COUNT(*) FILTER (WHERE receipt.seller_key IS NOT NULL AND receipt.seller_key <> $3)::int
             FROM inventory_receipt_batch_links link
             JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
             WHERE link.batch_number = $1 AND receipt.sku = $2",
        )
        .bind(batch_number)
        .bind(sku)
        .bind(seller)
        .fetch_one(&mut *conn)
        .await?;
        if other_sellers > 0 {
            return rejected(format!(
                "SKU {sku} has receipt lots assigned to a different seller."
            ));
        }
        if linked != quantity_delta {
            return rejected(format!(
                "SKU {sku} publication quantity {quantity_delta} does not match linked receipt quantity {linked}."
            ));
        }
        sqlx::query(
            "INSERT INTO inventory_publication_receipt_links
               (publication_item_id, receipt_id, planned_quantity, target_seller_key)
             SELECT $1, link.receipt_id, link.linked_quantity, $4
             FROM inventory_receipt_batch_links link
             JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
             WHERE link.batch_number = $2 AND receipt.sku = $3",
        )
        .bind(item_id)
        .bind(batch_number)
        .bind(sku)
        .bind(seller)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// What automatic planning reads of the publication settings and the publisher's state
/// (`InventoryPublicationConfiguration`).
#[derive(Clone, Debug, PartialEq)]
pub struct Configuration {
    pub policy: Policy,
    pub global_paused: bool,
    pub circuit_open: bool,
    pub authentication_invalid: bool,
    /// The seller continuous pricing publishes to.
    pub seller_key: Option<String>,
}

impl Configuration {
    /// Whether a batch from `source` publishes by itself (`isAutomaticPublicationAvailable`).
    pub fn publishes(&self, source: Source) -> bool {
        self.policy.automatic_publishing_enabled
            && self.policy.automatic_sources.contains(&source)
            && !self.global_paused
            && !self.circuit_open
            && !self.authentication_invalid
    }

    /// The stored settings and state; the defaults when there are none.
    pub async fn load(conn: &mut PgConnection) -> sqlx::Result<Configuration> {
        let row: Option<(Value, String, bool)> = sqlx::query_as(
            "SELECT settings_json, authentication_status, circuit_open
             FROM inventory_publication_settings WHERE config_key = 'default'",
        )
        .fetch_optional(&mut *conn)
        .await?;
        let (settings, authentication, circuit_open) =
            row.unwrap_or_else(|| (json!({}), "unknown".into(), false));
        Ok(Configuration {
            policy: Policy::of(&settings["policy"]),
            global_paused: settings["globalPaused"].as_bool().unwrap_or(false),
            circuit_open,
            authentication_invalid: authentication == "invalid",
            seller_key: non_empty(settings["continuousPricing"]["sellerKey"].as_str()),
        })
    }
}

/// Why a batch planned no publication by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skipped {
    BatchNotFound,
    /// Its source does not publish by itself, publishing is paused or stopped, or an intake run
    /// queued it with its own say over publishing.
    Unavailable,
    /// The pricing configuration changed after the batch was priced.
    SupersededPricingConfig,
    NoEligibleItems,
}

/// What automatic planning did.
#[derive(Clone, Debug, PartialEq)]
pub enum Automatic {
    Skipped(Skipped),
    Planned {
        publication_id: i64,
        created: bool,
        eligible_count: usize,
    },
}

/// Plans the batch's publication when its source publishes by itself, priced under the pricing
/// configuration still `current`. Run it in a transaction.
pub async fn plan_automatic(
    conn: &mut PgConnection,
    batch_number: i32,
    configuration: &Configuration,
    current: &Config,
    now: DateTime<Utc>,
) -> Result<Automatic, Error> {
    let skipped = |why| Ok(Automatic::Skipped(why));
    // An intake run's queue action carries its own say over publishing: a pricing-only action
    // never inherits the source's automatic publishing.
    let run: Option<i64> = sqlx::query_scalar(
        "SELECT 1::int8 FROM inventory_intake_runs WHERE batch_number = $1 LIMIT 1",
    )
    .bind(batch_number)
    .fetch_optional(&mut *conn)
    .await?;
    if run.is_some() {
        return skipped(Skipped::Unavailable);
    }
    let batch: Option<(String, i32, Option<Value>)> = sqlx::query_as(
        "SELECT b.source_type, b.successful_count, job.config_json
         FROM inventory_batches b
         LEFT JOIN LATERAL (
           SELECT config_json FROM inventory_batch_pricing_jobs
           WHERE batch_number = b.batch_number ORDER BY created_at DESC, id DESC LIMIT 1
         ) job ON TRUE
         WHERE b.batch_number = $1",
    )
    .bind(batch_number)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((source_type, successful_count, job_config)) = batch else {
        return skipped(Skipped::BatchNotFound);
    };
    let Some(source) = Source::of(&source_type) else {
        // A strategy batch is analysis only.
        return skipped(Skipped::Unavailable);
    };
    if let (Source::Continuous, Some(job)) = (source, &job_config) {
        let priced_under = Config::of(
            &job["pricing"],
            &job["supplyAnalysis"],
            &job["productLinePricing"],
        );
        if priced_under != *current {
            return skipped(Skipped::SupersededPricingConfig);
        }
    }
    if !configuration.publishes(source) {
        return skipped(Skipped::Unavailable);
    }
    if successful_count == 0 {
        return skipped(Skipped::NoEligibleItems);
    }
    let Some((batch, items, results)) = preview::load(conn, batch_number).await? else {
        return skipped(Skipped::BatchNotFound);
    };
    let known = preview::known(conn, batch_number, &items, &results, None).await?;
    let policy = &configuration.policy;
    let preview = preview::preview(&batch, &items, &results, &known, policy, now, true)
        .map_err(Error::Rejected)?;
    if preview.eligible_count == 0 {
        return skipped(Skipped::NoEligibleItems);
    }
    let items = publishable(&preview, None)?;
    let publication = new_publication(
        &preview,
        policy,
        Mode::Automatic,
        &items,
        None,
        configuration.seller_key.as_deref(),
    )?;
    let (publication_id, created) = create_or_find(conn, &publication).await?;
    Ok(Automatic::Planned {
        publication_id,
        created,
        eligible_count: preview.eligible_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// A publication Node planned: its id, batch, config, seller and when.
    type NodePlan = (i64, i32, Value, Option<String>, DateTime<Utc>);

    #[test]
    fn a_selection_is_sorted_once_and_keyed_by_its_hash() {
        assert_eq!(selected_skus(None).unwrap(), None);
        assert_eq!(selected_skus(Some(&[9, 3, 9])).unwrap(), Some(vec![3, 9]));
        for bad in [&[][..], &[0], &[4, -1], &[i64::from(i32::MAX) + 1]] {
            assert!(matches!(selected_skus(Some(bad)), Err(Error::Rejected(_))));
        }
        assert_eq!(planning_key(17, None), "inventory-batch-pricing-job:17");
        // sha256("3,9") = 0ae4...; the key keeps its first 16 hex digits.
        let key = planning_key(17, Some(&[3, 9]));
        let digest = Sha256::digest(b"3,9");
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            key,
            format!("inventory-batch-pricing-job:17:selection:{}", &hex[..16])
        );
    }

    #[test]
    fn numbers_are_the_same_json_whatever_their_form() {
        assert!(same_json(
            &json!({"a": 1, "b": [2.5]}),
            &json!({"b": [2.5], "a": 1.0})
        ));
        assert!(!same_json(&json!({"a": 1}), &json!({"a": 1, "b": null})));
    }

    /// Plans again every automatic publication Node planned under the rules ported here, as it
    /// stood when Node planned it, inside a transaction that is rolled back: each must find
    /// Node's publication under its key and match it item for item.
    #[tokio::test]
    #[ignore = "reads the dev database; writes only in a transaction that is rolled back"]
    async fn plans_find_what_node_planned() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let publications: Vec<NodePlan> = sqlx::query_as(
            "SELECT id, batch_number, config_json, seller_key, created_at FROM inventory_publications
             WHERE config_json->>'mode' = 'automatic' AND batch_number IS NOT NULL
               AND created_at >= '2026-09-26T17:00:07Z'
             ORDER BY id",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let (mut found, mut skipped, mut different) = (0, 0, Vec::new());
        for (id, batch_number, config, seller_key, created_at) in &publications {
            let (batch, items, results) = preview::load(&mut tx, *batch_number)
                .await
                .unwrap()
                .unwrap();
            if results.iter().any(|r| r.priced_at > *created_at) {
                skipped += 1;
                continue;
            }
            let known = preview::known(&mut tx, *batch_number, &items, &results, Some(*id))
                .await
                .unwrap();
            let policy = Policy::of(&config["policy"]);
            let outcome = async {
                let preview =
                    preview::preview(&batch, &items, &results, &known, &policy, *created_at, true)
                        .map_err(Error::Rejected)?;
                let chosen = publishable(&preview, None)?;
                let publication = new_publication(
                    &preview,
                    &policy,
                    Mode::Automatic,
                    &chosen,
                    None,
                    seller_key.as_deref(),
                )?;
                if !same_json(&publication.config, config) {
                    return rejected(format!("config {} vs {config}", publication.config));
                }
                create_or_find(&mut tx, &publication).await
            }
            .await;
            match outcome {
                Ok((found_id, false)) if found_id == *id => found += 1,
                Ok(other) => different.push((*id, format!("{other:?}"))),
                Err(why) => different.push((*id, why.to_string())),
            }
        }
        tx.rollback().await.unwrap();
        println!(
            "{} automatic publications: {found} found as planned, {} different, {skipped} repriced since",
            publications.len(),
            different.len()
        );
        for (id, why) in different.iter().take(10) {
            println!("  publication {id}: {why}");
        }
        assert!(different.is_empty());
    }

    /// Each reason a batch plans nothing by itself, and Node's latest automatic publication
    /// planned again by `plan_automatic` as things stood then, inside a transaction that is rolled
    /// back.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_batch_plans_by_itself_only_when_its_source_publishes() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let (id, batch_number, config, seller_key, created_at, job): (
            i64,
            i32,
            Value,
            Option<String>,
            DateTime<Utc>,
            Value,
        ) = sqlx::query_as(
            "SELECT p.id, p.batch_number, p.config_json, p.seller_key, p.created_at, j.config_json
             FROM inventory_publications p JOIN inventory_batch_pricing_jobs j ON j.id = p.pricing_job_id
             WHERE p.config_json->>'mode' = 'automatic' AND p.source_type = 'continuous'
             ORDER BY p.id DESC LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let priced_under = Config::of(
            &job["pricing"],
            &job["supplyAnalysis"],
            &job["productLinePricing"],
        );
        let configuration = Configuration {
            policy: Policy::of(&config["policy"]),
            global_paused: false,
            circuit_open: false,
            authentication_invalid: false,
            seller_key,
        };
        let mut plan = async |batch: i32, configuration: &Configuration, current: &Config| {
            plan_automatic(&mut tx, batch, configuration, current, created_at)
                .await
                .unwrap()
        };
        assert_eq!(
            plan(-1, &configuration, &priced_under).await,
            Automatic::Skipped(Skipped::BatchNotFound)
        );
        let paused = Configuration {
            global_paused: true,
            ..configuration.clone()
        };
        assert_eq!(
            plan(batch_number, &paused, &priced_under).await,
            Automatic::Skipped(Skipped::Unavailable)
        );
        let stopped = Configuration {
            circuit_open: true,
            ..configuration.clone()
        };
        assert_eq!(
            plan(batch_number, &stopped, &priced_under).await,
            Automatic::Skipped(Skipped::Unavailable)
        );
        let mut changed = priced_under.clone();
        changed.pricing.default_percentile += 1.0;
        assert_eq!(
            plan(batch_number, &configuration, &changed).await,
            Automatic::Skipped(Skipped::SupersededPricingConfig)
        );
        assert_eq!(
            plan(batch_number, &configuration, &priced_under).await,
            Automatic::Skipped(Skipped::NoEligibleItems),
            "Node's publication holds every candidate"
        );
        drop(plan);
        let theirs = written(&mut tx, id).await;
        for statement in [
            "DELETE FROM inventory_publication_receipt_links WHERE publication_item_id IN
               (SELECT id FROM inventory_publication_items WHERE publication_id = $1)",
            "DELETE FROM inventory_publication_items WHERE publication_id = $1",
            "DELETE FROM inventory_publications WHERE id = $1",
        ] {
            sqlx::query(statement)
                .bind(id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        let Automatic::Planned {
            publication_id,
            created,
            eligible_count,
        } = plan_automatic(
            &mut tx,
            batch_number,
            &configuration,
            &priced_under,
            created_at,
        )
        .await
        .unwrap()
        else {
            panic!("the batch plans again once Node's publication is gone");
        };
        assert!(created && eligible_count > 0);
        assert!(same_json(&written(&mut tx, publication_id).await, &theirs));

        let strategy: Option<i32> = sqlx::query_scalar(
            "SELECT batch_number FROM inventory_batches WHERE source_type = 'strategy' LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await
        .unwrap();
        let intake: Option<i32> =
            sqlx::query_scalar("SELECT batch_number FROM inventory_intake_runs LIMIT 1")
                .fetch_optional(&mut *tx)
                .await
                .unwrap();
        for batch in strategy.into_iter().chain(intake) {
            assert_eq!(
                plan_automatic(&mut tx, batch, &configuration, &priced_under, created_at)
                    .await
                    .unwrap(),
                Automatic::Skipped(Skipped::Unavailable),
                "batch {batch}"
            );
        }
        tx.rollback().await.unwrap();
    }

    /// What a publication wrote, without what publishing it later changed.
    async fn written(conn: &mut PgConnection, id: i64) -> Value {
        sqlx::query_scalar(
            "SELECT jsonb_build_object(
               'publication', (SELECT jsonb_build_object('key', planning_key, 'batch', batch_number,
                   'job', pricing_job_id, 'method', method, 'source', source_type, 'seller', seller_key,
                   'config', config_json) FROM inventory_publications WHERE id = $1),
               'items', (SELECT jsonb_agg(
                   to_jsonb(i) - ARRAY['id', 'publication_id', 'status', 'error_code', 'error_message',
                     'published_at', 'created_at', 'updated_at', 'forecast_evidence',
                     'forecast_evidence_provenance']
                   || CASE WHEN i.forecast_evidence->>'source' = 'historical_pricing_result_exact_match'
                        THEN '{}'::jsonb
                        ELSE jsonb_build_object('evidence', i.forecast_evidence,
                               'provenance', i.forecast_evidence_provenance) END
                   ORDER BY i.id) FROM inventory_publication_items i WHERE i.publication_id = $1),
               'links', (SELECT jsonb_agg(jsonb_build_object('sku', i.sku, 'receipt', l.receipt_id,
                   'quantity', l.planned_quantity, 'seller', l.target_seller_key) ORDER BY i.id, l.receipt_id)
                   FROM inventory_publication_receipt_links l
                   JOIN inventory_publication_items i ON i.id = l.publication_item_id
                   WHERE i.publication_id = $1))",
        )
        .bind(id)
        .fetch_one(conn)
        .await
        .unwrap()
    }

    /// Node's publications taken away inside a transaction that is rolled back, and planned
    /// again: the received inventory one (its receipt links too) and the latest continuous ones
    /// write what Node wrote, but for times Node never wrote finer than the millisecond.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_plan_made_again_writes_what_node_wrote() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let publications: Vec<NodePlan> = sqlx::query_as(
            "(SELECT id, batch_number, config_json, seller_key, created_at FROM inventory_publications
              WHERE config_json->>'mode' = 'automatic' AND source_type = 'pending_inventory'
                AND created_at >= '2026-09-26T17:00:07Z')
             UNION ALL
             (SELECT id, batch_number, config_json, seller_key, created_at FROM inventory_publications
              WHERE config_json->>'mode' = 'automatic' AND source_type = 'continuous'
                AND created_at >= '2026-09-26T17:00:07Z' ORDER BY id DESC LIMIT 25)",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert!(publications.len() > 1);
        let mut different = Vec::new();
        for (id, batch_number, config, seller_key, created_at) in &publications {
            let theirs = written(&mut tx, *id).await;
            let (batch, items, results) = preview::load(&mut tx, *batch_number)
                .await
                .unwrap()
                .unwrap();
            let known = preview::known(&mut tx, *batch_number, &items, &results, Some(*id))
                .await
                .unwrap();
            for statement in [
                "DELETE FROM inventory_publication_receipt_links WHERE publication_item_id IN
                   (SELECT id FROM inventory_publication_items WHERE publication_id = $1)",
                "DELETE FROM inventory_publication_items WHERE publication_id = $1",
                "DELETE FROM inventory_publications WHERE id = $1",
            ] {
                sqlx::query(statement)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            let policy = Policy::of(&config["policy"]);
            let preview =
                preview::preview(&batch, &items, &results, &known, &policy, *created_at, true)
                    .unwrap();
            let chosen = publishable(&preview, None).unwrap();
            let publication = new_publication(
                &preview,
                &policy,
                Mode::Automatic,
                &chosen,
                None,
                seller_key.as_deref(),
            )
            .unwrap();
            let (ours_id, created) = create_or_find(&mut tx, &publication).await.unwrap();
            assert!(created);
            let ours = written(&mut tx, ours_id).await;
            if !same_json(&ours, &theirs) {
                different.push((*id, ours, theirs));
            }
        }
        tx.rollback().await.unwrap();
        println!(
            "{} publications planned again: {} different",
            publications.len(),
            different.len()
        );
        for (id, ours, theirs) in different.iter().take(3) {
            println!("  publication {id}\n    ours   {ours}\n    theirs {theirs}");
        }
        assert!(different.is_empty());
    }
}
