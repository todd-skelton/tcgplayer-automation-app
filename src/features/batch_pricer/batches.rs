//! Inventory batches as the Node app keeps them: frozen sets of SKUs (from the Inventory Manager,
//! a seller's live inventory or a CSV) that its pricing worker prices and its publisher publishes.
//! Reading and every write go through its `/api/inventory-batches` routes, whose rules (one active
//! pricing job per batch, the publication safety checks, deleting only an unpublished batch) stay
//! there with the workers.
use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use corten::UrlValue;
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchStatus {
    Pending,
    Queued,
    Pricing,
    Priced,
    Failed,
}

impl BatchStatus {
    pub fn word(self) -> &'static str {
        match self {
            BatchStatus::Pending => "pending",
            BatchStatus::Queued => "queued",
            BatchStatus::Pricing => "pricing",
            BatchStatus::Priced => "priced",
            BatchStatus::Failed => "failed",
        }
    }
}

/// What a pricing job prices: every SKU, or only those that need review.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Full,
    Errors,
    Cached,
}

impl Mode {
    pub fn word(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Errors => "errors",
            Mode::Cached => "cached",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Pricing,
    Completed,
    Failed,
}

impl JobStatus {
    pub fn word(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Pricing => "pricing",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
        }
    }
}

/// How far a pricing job got, as its worker reports it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Progress {
    pub current: f64,
    pub total: f64,
    pub status: String,
    pub processed: f64,
    pub skipped: f64,
    pub errors: f64,
    pub warnings: f64,
    pub phase: Option<String>,
    pub sub_progress: Option<SubProgress>,
    /// When the phase began, in milliseconds since the epoch.
    pub phase_start_time: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct SubProgress {
    pub current: f64,
    pub total: f64,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// A Postgres `bigint`, which the Node app sends as text.
    #[serde(deserialize_with = "integer")]
    pub id: i64,
    pub mode: Mode,
    pub status: JobStatus,
    pub progress: Option<Progress>,
    pub error_message: Option<String>,
    pub updated_at: DateTime<Utc>,
}

impl Job {
    pub fn active(&self) -> bool {
        matches!(self.status, JobStatus::Queued | JobStatus::Pricing)
    }
}

/// An integer sent as a JSON number or as text, as `pg` sends a `bigint`.
fn integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Integer {
        Number(i64),
        Text(String),
    }
    match Integer::deserialize(deserializer)? {
        Integer::Number(n) => Ok(n),
        Integer::Text(text) => text.parse().map_err(serde::de::Error::custom),
    }
}

/// Totals of a batch's prices by kind, weighted by quantity.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Totals {
    pub market_price: f64,
    pub low_price: Option<f64>,
    pub marketplace_price: Option<f64>,
    /// By percentile key: `"75th"`.
    pub percentiles: BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DaysToSell {
    pub percentiles: BTreeMap<String, f64>,
    pub market_adjusted_percentiles: Option<BTreeMap<String, f64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LineBreakdown {
    pub count: f64,
    pub percentiles_used: Option<Vec<f64>>,
    /// Summaries written before several percentiles per line kept one.
    pub percentile_used: Option<f64>,
    pub total_value: f64,
}

impl LineBreakdown {
    /// `75th, 80th`, or `N/A`.
    pub fn percentiles(&self) -> String {
        let used: Vec<f64> = match (&self.percentiles_used, self.percentile_used) {
            (Some(used), _) => used.clone(),
            (None, Some(one)) => vec![one],
            (None, None) => Vec::new(),
        };
        if used.is_empty() {
            return "N/A".to_owned();
        }
        used.iter()
            .map(|p| format!("{p}th"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// What a batch's saved pricing results come to.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub total_rows: f64,
    pub processed_rows: f64,
    pub manual_review_rows: f64,
    pub skipped_rows: f64,
    pub error_rows: f64,
    pub warning_rows: f64,
    pub success_rate: f64,
    pub file_name: String,
    pub total_quantity: f64,
    pub total_add_quantity: f64,
    pub totals: Totals,
    pub totals_with_market: Totals,
    pub median_days_to_sell: DaysToSell,
    pub product_line_breakdown: Option<BTreeMap<String, LineBreakdown>>,
}

impl Summary {
    pub fn combined_quantity(&self) -> f64 {
        self.total_quantity + self.total_add_quantity
    }

    /// The percentile keys in order: `5th`, `10th`, ...
    pub fn percentile_keys(&self) -> Vec<String> {
        let mut keys: Vec<(i64, &String)> = self
            .totals
            .percentiles
            .keys()
            .filter_map(|k| k.trim_end_matches("th").parse().ok().map(|n| (n, k)))
            .collect();
        keys.sort();
        keys.into_iter().map(|(_, k)| k.clone()).collect()
    }
}

/// `value` against the market value, in percent, or none without a market value.
pub fn percent_from_market(value: f64, market: f64) -> Option<f64> {
    (market > 0.0).then(|| (value - market) / market * 100.0)
}

/// A batch and its latest pricing job.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub batch_number: i32,
    pub status: BatchStatus,
    pub source_type: String,
    pub source_label: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_priced_at: Option<DateTime<Utc>>,
    pub summary: Option<Summary>,
    pub successful_count: i64,
    pub manual_review_count: i64,
    pub item_count: i64,
    pub latest_job: Option<Job>,
}

impl Batch {
    /// `Seller: 8520a14f`, `CSV: cards.csv`, `Inventory Manager`.
    pub fn source(&self) -> String {
        match self.source_type.as_str() {
            "seller" => format!("Seller: {}", self.source_label),
            "csv" => format!("CSV: {}", self.source_label),
            _ => self.source_label.clone(),
        }
    }

    /// Whether its pricing job is queued or running.
    pub fn pricing(&self) -> bool {
        self.latest_job.as_ref().is_some_and(Job::active)
    }

    pub fn has_results(&self) -> bool {
        self.last_priced_at.is_some()
    }
}

/// An item a publication changes, by its status alone.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PublicationItem {
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub id: i64,
    pub planning_key: String,
    pub pricing_job_id: Option<i64>,
    pub status: String,
    #[serde(default)]
    pub items: Vec<PublicationItem>,
}

const ACTIVE_PUBLICATION: [&str; 4] = ["planned", "staging", "staged", "publishing"];

impl Publication {
    pub fn active(&self) -> bool {
        ACTIVE_PUBLICATION.contains(&self.status.as_str())
    }
}

/// A priced SKU the publisher could send, and why not when it cannot.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub sku: i64,
    pub product_id: i64,
    pub product_name: Option<String>,
    pub condition: String,
    pub previous_price: Option<f64>,
    pub desired_price: Option<f64>,
    pub quantity_delta: i64,
    pub eligible: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
}

impl Candidate {
    /// How far the price moves, absolutely and relative to the old price; a new or unpriced SKU
    /// last.
    fn change(&self) -> (f64, f64) {
        match (self.previous_price, self.desired_price) {
            (Some(before), Some(after)) => {
                let absolute = (after - before).abs();
                let relative = if before != 0.0 && after != 0.0 {
                    absolute / before
                } else {
                    f64::INFINITY
                };
                (absolute, relative)
            }
            _ => (f64::INFINITY, f64::INFINITY),
        }
    }
}

/// What publishing the batch's latest results would send.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub planning_key: String,
    pub eligible_count: i64,
    pub excluded_count: i64,
    pub items: Vec<Candidate>,
}

/// A batch's publications, newest first, and what publishing it now would send.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Publications {
    pub preview: Option<Preview>,
    pub publications: Vec<Publication>,
}

/// How the latest publication run went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    InProgress,
    Published,
    Failed,
    Ambiguous,
}

impl RunStatus {
    pub fn word(self) -> &'static str {
        match self {
            RunStatus::InProgress => "in progress",
            RunStatus::Published => "published",
            RunStatus::Failed => "failed",
            RunStatus::Ambiguous => "ambiguous",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub status: RunStatus,
    pub publications: usize,
    pub published: usize,
    pub failed: usize,
    pub ambiguous: usize,
}

impl Publications {
    pub fn active(&self) -> bool {
        self.publications.iter().any(Publication::active)
    }

    /// Whether the plan publishing would make was made already.
    pub fn plan_exists(&self) -> bool {
        self.preview.as_ref().is_some_and(|p| {
            self.publications
                .iter()
                .any(|x| x.planning_key == p.planning_key)
        })
    }

    /// The SKUs ready to publish, the smallest price change first.
    pub fn ready(&self) -> Vec<&Candidate> {
        let mut ready: Vec<&Candidate> = self
            .preview
            .iter()
            .flat_map(|p| p.items.iter())
            .filter(|c| c.eligible)
            .collect();
        ready.sort_by(|a, b| {
            let (a_abs, a_rel) = a.change();
            let (b_abs, b_rel) = b.change();
            a_abs
                .total_cmp(&b_abs)
                .then(a_rel.total_cmp(&b_rel))
                .then(a.sku.cmp(&b.sku))
        });
        ready
    }

    /// What is selected at first: every inventory change, or when there is none the 20 smallest
    /// price changes, as a canary.
    pub fn recommended(&self) -> HashSet<i64> {
        let ready = self.ready();
        let changes: HashSet<i64> = ready
            .iter()
            .filter(|c| c.quantity_delta != 0)
            .map(|c| c.sku)
            .collect();
        if !changes.is_empty() {
            return changes;
        }
        ready
            .iter()
            .filter(|c| c.quantity_delta == 0)
            .take(20)
            .map(|c| c.sku)
            .collect()
    }

    /// The run of the newest publication: the publications of its pricing job.
    pub fn latest_run(&self) -> Option<Run> {
        let latest = self.publications.first()?;
        let run: Vec<&Publication> = self
            .publications
            .iter()
            .filter(|p| match latest.pricing_job_id {
                None => p.id == latest.id,
                Some(job) => p.pricing_job_id == Some(job),
            })
            .collect();
        let items = || run.iter().flat_map(|p| p.items.iter());
        let count = |status: &str| items().filter(|i| i.status == status).count();
        let (published, failed, ambiguous) =
            (count("published"), count("failed"), count("ambiguous"));
        let status = if run.iter().any(|p| p.active()) {
            RunStatus::InProgress
        } else if failed > 0
            || run
                .iter()
                .any(|p| p.status == "failed" || p.status == "rolled_back")
        {
            RunStatus::Failed
        } else if ambiguous > 0 || run.iter().any(|p| p.status == "ambiguous") {
            RunStatus::Ambiguous
        } else {
            RunStatus::Published
        };
        Some(Run {
            status,
            publications: run.len(),
            published,
            failed,
            ambiguous,
        })
    }
}

/// The newest 100 batches made by hand.
pub async fn list(legacy: &Legacy) -> Result<Vec<Batch>, String> {
    legacy.read("/api/inventory-batches").await
}

pub async fn one(legacy: &Legacy, batch: i32) -> Result<Batch, String> {
    legacy
        .read(&format!("/api/inventory-batches/{batch}"))
        .await
}

pub async fn publications(legacy: &Legacy, batch: i32) -> Result<Publications, String> {
    legacy
        .read(&format!("/api/inventory-batches/{batch}/publications"))
        .await
}

/// Which saved results: those priced, or those for manual review.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Successful,
    ManualReview,
}

impl Scope {
    pub fn file_name(self, batch: i32) -> String {
        match self {
            Scope::Successful => format!("inventory-batch-{batch}.csv"),
            Scope::ManualReview => format!("inventory-batch-{batch}-manual-review.csv"),
        }
    }

    fn query(self) -> &'static str {
        match self {
            Scope::Successful => "successful",
            Scope::ManualReview => "manual-review",
        }
    }
}

/// A saved result's TCGplayer listing row, its columns in the order they were saved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row(pub Vec<(String, String)>);

impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Columns;
        impl<'de> serde::de::Visitor<'de> for Columns {
            type Value = Row;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a listing row")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Row, A::Error> {
                let mut columns = Vec::new();
                while let Some((name, value)) = map.next_entry::<String, serde_json::Value>()? {
                    let text = match value {
                        serde_json::Value::Null => String::new(),
                        serde_json::Value::String(s) => s,
                        other => other.to_string(),
                    };
                    columns.push((name, text));
                }
                Ok(Row(columns))
            }
        }
        deserializer.deserialize_map(Columns)
    }
}

#[derive(Deserialize)]
struct Saved {
    row: Row,
}

pub async fn results(legacy: &Legacy, batch: i32, scope: Scope) -> Result<Vec<Row>, String> {
    let saved: Vec<Saved> = legacy
        .read(&format!(
            "/api/inventory-batches/{batch}/results?scope={}",
            scope.query()
        ))
        .await?;
    Ok(saved.into_iter().map(|s| s.row).collect())
}

/// The rows as CSV the way the React screen wrote them (Papa Parse): the first row's columns as
/// the header, a field quoted when it holds a comma, a quote, a line break, or space at either
/// end, lines ended by CRLF and none after the last.
pub fn csv(rows: &[Row]) -> String {
    fn field(text: &str) -> String {
        let quoted =
            text.contains([',', '"', '\n', '\r']) || text.starts_with(' ') || text.ends_with(' ');
        if quoted {
            format!("\"{}\"", text.replace('"', "\"\""))
        } else {
            text.to_owned()
        }
    }
    let Some(first) = rows.first() else {
        return String::new();
    };
    let header: Vec<&str> = first.0.iter().map(|(name, _)| name.as_str()).collect();
    let mut lines = vec![
        header
            .iter()
            .map(|h| field(h))
            .collect::<Vec<_>>()
            .join(","),
    ];
    for row in rows {
        let line: Vec<String> = header
            .iter()
            .map(|name| {
                field(
                    row.0
                        .iter()
                        .find(|(n, _)| n == name)
                        .map_or("", |(_, v)| v.as_str()),
                )
            })
            .collect();
        lines.push(line.join(","));
    }
    lines.join("\r\n")
}

#[derive(Serialize)]
struct PriceRequest {
    mode: Mode,
}

#[derive(Deserialize)]
struct PriceAnswer {
    status: Option<String>,
}

/// Queues a pricing job, or finds the one already running; the words for what happened.
pub async fn price(legacy: &Legacy, batch: i32, mode: Mode) -> Result<String, String> {
    let answer: PriceAnswer = legacy
        .send(
            &format!("/api/inventory-batches/{batch}/pricing-jobs"),
            &PriceRequest { mode },
        )
        .await?;
    Ok(match answer.status.as_deref() {
        Some("pricing") => format!("Batch {batch} is already pricing"),
        Some("queued") => format!("Batch {batch} queued for pricing"),
        _ => format!("Batch {batch} pricing requested"),
    })
}

pub async fn delete(legacy: &Legacy, batch: i32) -> Result<(), String> {
    let _: serde_json::Value = legacy
        .delete(&format!("/api/inventory-batches/{batch}"))
        .await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishRequest<'a> {
    selected_skus: &'a [i64],
}

#[derive(Deserialize)]
struct Published {
    publications: Vec<serde_json::Value>,
}

/// Plans the selected SKUs' publication to Seller Portal; how many publications it made.
pub async fn publish(legacy: &Legacy, batch: i32, skus: &[i64]) -> Result<usize, String> {
    let published: Published = legacy
        .send(
            &format!("/api/inventory-batches/{batch}/publications"),
            &PublishRequest {
                selected_skus: skus,
            },
        )
        .await?;
    Ok(published.publications.len())
}

/// A batch frozen from a CSV export, queued for pricing.
pub async fn import_csv(legacy: &Legacy, file_name: &str, bytes: Vec<u8>) -> Result<Batch, String> {
    legacy
        .send_file(
            "/api/inventory-batches/import-csv",
            "file",
            file_name,
            bytes,
        )
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SellerRequest<'a> {
    seller_key: &'a str,
}

/// A batch frozen from a seller's live inventory, queued for pricing.
pub async fn import_seller(legacy: &Legacy, seller_key: &str) -> Result<Batch, String> {
    legacy
        .send(
            "/api/inventory-batches/import-seller",
            &SellerRequest { seller_key },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(sku: i64, before: Option<f64>, after: Option<f64>, delta: i64) -> Candidate {
        Candidate {
            sku,
            product_id: 1,
            product_name: None,
            condition: "Near Mint".into(),
            previous_price: before,
            desired_price: after,
            quantity_delta: delta,
            eligible: true,
            reasons: Vec::new(),
        }
    }

    fn preview(items: Vec<Candidate>) -> Publications {
        Publications {
            preview: Some(Preview {
                planning_key: "k".into(),
                eligible_count: items.len() as i64,
                excluded_count: 0,
                items,
            }),
            publications: Vec::new(),
        }
    }

    #[test]
    fn ready_skus_go_smallest_change_first_and_new_ones_last() {
        let p = preview(vec![
            candidate(1, Some(10.0), Some(12.0), 0),
            candidate(2, None, Some(5.0), 0),
            candidate(3, Some(10.0), Some(10.5), 0),
        ]);
        let order: Vec<i64> = p.ready().iter().map(|c| c.sku).collect();
        assert_eq!(order, vec![3, 1, 2]);
    }

    #[test]
    fn inventory_changes_are_recommended_over_a_price_canary() {
        let p = preview(vec![
            candidate(1, Some(1.0), Some(2.0), 0),
            candidate(2, Some(1.0), Some(2.0), 3),
        ]);
        assert_eq!(p.recommended(), HashSet::from([2]));
        let canary = preview(
            (1..=25)
                .map(|n| candidate(n, Some(1.0), Some(1.0 + n as f64), 0))
                .collect(),
        );
        assert_eq!(canary.recommended().len(), 20);
        assert!(canary.recommended().contains(&1) && !canary.recommended().contains(&21));
    }

    #[test]
    fn the_latest_run_is_its_pricing_jobs_publications() {
        let publication = |id, job, status: &str, items: &[&str]| Publication {
            id,
            planning_key: String::new(),
            pricing_job_id: job,
            status: status.into(),
            items: items
                .iter()
                .map(|s| PublicationItem {
                    status: (*s).into(),
                })
                .collect(),
        };
        let p = Publications {
            preview: None,
            publications: vec![
                publication(3, Some(9), "published", &["published", "failed"]),
                publication(2, Some(9), "published", &["published"]),
                publication(1, Some(8), "failed", &["failed"]),
            ],
        };
        let run = p.latest_run().unwrap();
        assert_eq!(
            (run.status, run.publications, run.published, run.failed),
            (RunStatus::Failed, 2, 2, 1)
        );
    }

    #[test]
    fn rows_are_written_as_papa_parse_writes_them() {
        let row = |a: &str, b: &str| {
            Row(vec![
                ("Product".into(), a.into()),
                ("Price".into(), b.into()),
            ])
        };
        let text = csv(&[row("Pikachu, Base", "1.00"), row("Say \"hi\"", "")]);
        assert_eq!(
            text,
            "Product,Price\r\n\"Pikachu, Base\",1.00\r\n\"Say \"\"hi\"\"\","
        );
    }

    #[test]
    fn a_row_keeps_its_column_order() {
        let row: Row = serde_json::from_str(r#"{"Z":"1","A":null,"M":2}"#).unwrap();
        assert_eq!(
            row.0,
            vec![
                ("Z".into(), "1".into()),
                ("A".into(), String::new()),
                ("M".into(), "2".into())
            ]
        );
    }

    #[test]
    fn a_batch_reads_as_the_node_app_answers() {
        let json = r#"{"batchNumber":2733,"status":"priced","sourceType":"pending_inventory","sourceLabel":"Inventory Manager",
            "createdAt":"2026-09-26T17:15:37.620Z","updatedAt":"2026-09-26T18:07:28.439Z","lastPricedAt":null,
            "summary":{"totalRows":66,"successRate":100,"totals":{"marketPrice":2478.06,"lowPrice":1346.46,"percentiles":{"10th":1,"5th":2}}},
            "successfulCount":66,"manualReviewCount":0,"itemCount":66,
            "latestJob":{"id":"2738","mode":"full","status":"pricing","progress":{"current":2,"total":4,"status":"Fetching","processed":1,"skipped":0,"errors":0,"warnings":0},"errorMessage":null,"updatedAt":"2026-09-26T18:07:28.439Z"}}"#;
        let batch: Batch = serde_json::from_str(json).unwrap();
        assert!(batch.pricing());
        assert_eq!(batch.latest_job.as_ref().map(|j| j.id), Some(2738));
        assert_eq!(
            batch.summary.unwrap().percentile_keys(),
            vec!["5th", "10th"]
        );
    }
}
