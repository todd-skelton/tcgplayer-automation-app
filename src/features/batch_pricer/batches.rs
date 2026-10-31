//! Inventory batches as the Node app keeps them: frozen sets of SKUs (from the Inventory Manager,
//! a seller's live inventory or a CSV) that its pricing worker prices and its publisher publishes.
//! The batches, their latest jobs, saved results and publications (with what publishing would
//! send) are read here, and a batch deleted here, as `inventoryBatches.server.ts` does. Pricing,
//! publishing and importing still go through the Node app's `/api/inventory-batches` routes, whose
//! rules (one active pricing job per batch, the publication safety checks) stay there with the
//! workers.
use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use corten::UrlValue;
use serde::{Deserialize, Serialize};

use crate::{
    database::Database,
    features::inventory_publication::{
        plan::{self, Configuration},
        preview,
    },
    legacy::Legacy,
};

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

impl Preview {
    fn of(preview: preview::Preview) -> Preview {
        Preview {
            planning_key: plan::planning_key(preview.pricing_job_id, None),
            eligible_count: preview.eligible_count as i64,
            excluded_count: preview.excluded_count as i64,
            items: preview
                .items
                .into_iter()
                .map(|item| Candidate {
                    sku: item.sku.into(),
                    product_id: item.product_id.into(),
                    product_name: Some(item.product_name),
                    condition: item.condition,
                    previous_price: item.previous_price,
                    desired_price: item.desired_price,
                    quantity_delta: item.quantity_delta.into(),
                    eligible: item.eligible,
                    reasons: item
                        .reasons
                        .iter()
                        .filter_map(|r| serde_json::to_value(r).ok()?.as_str().map(str::to_owned))
                        .collect(),
                })
                .collect(),
        }
    }
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

/// A batch as `batchSelect` reads it, before its latest job is attached.
#[derive(sqlx::FromRow)]
struct BatchRow {
    batch_number: i32,
    status: String,
    source_type: String,
    source_label: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    last_priced_at: Option<DateTime<Utc>>,
    summary: Option<String>,
    successful_count: i32,
    manual_review_count: i32,
    item_count: i32,
}

// Times are cut to milliseconds, as Node's `Date` reads them.
const BATCH_SELECT: &str = "SELECT b.batch_number, b.status, b.source_type, b.source_label,
  date_trunc('milliseconds', b.created_at) AS created_at, date_trunc('milliseconds', b.updated_at) AS updated_at,
  date_trunc('milliseconds', b.last_priced_at) AS last_priced_at, b.summary_json::text AS summary, b.successful_count,
  b.manual_review_count, COUNT(i.sku)::int AS item_count
FROM inventory_batches b LEFT JOIN inventory_batch_items i ON i.batch_number = b.batch_number";

const BATCH_GROUP: &str =
    "GROUP BY b.batch_number, b.status, b.source_type, b.source_label, b.created_at,
  b.updated_at, b.last_priced_at, b.summary_json, b.successful_count, b.manual_review_count";

#[derive(sqlx::FromRow)]
struct JobRow {
    batch_number: i32,
    id: i64,
    mode: String,
    status: String,
    progress: Option<String>,
    error_message: Option<String>,
    updated_at: DateTime<Utc>,
}

fn word<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(|e| e.to_string())
}

fn parsed<T: serde::de::DeserializeOwned>(json: Option<&str>) -> Result<Option<T>, String> {
    json.map(serde_json::from_str)
        .transpose()
        .map_err(|e| e.to_string())
}

impl JobRow {
    fn job(&self) -> Result<Job, String> {
        Ok(Job {
            id: self.id,
            mode: word(&self.mode)?,
            status: word(&self.status)?,
            progress: parsed(self.progress.as_deref())?,
            error_message: self.error_message.clone(),
            updated_at: self.updated_at,
        })
    }
}

/// `findLatestByBatchNumbers`: each batch's newest pricing job.
async fn latest_jobs(db: &Database, batches: &[i32]) -> Result<BTreeMap<i32, Job>, String> {
    let rows: Vec<JobRow> = sqlx::query_as(
        "SELECT DISTINCT ON (batch_number) batch_number, id, mode, status, progress_json::text AS progress,
           error_message, date_trunc('milliseconds', updated_at) AS updated_at
         FROM inventory_batch_pricing_jobs WHERE batch_number = ANY($1::int[])
         ORDER BY batch_number, created_at DESC, id DESC",
    )
    .bind(batches)
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| Ok((row.batch_number, row.job()?)))
        .collect()
}

async fn with_jobs(db: &Database, rows: Vec<BatchRow>) -> Result<Vec<Batch>, String> {
    let numbers: Vec<i32> = rows.iter().map(|row| row.batch_number).collect();
    let mut jobs = latest_jobs(db, &numbers).await?;
    rows.into_iter()
        .map(|row| {
            Ok(Batch {
                latest_job: jobs.remove(&row.batch_number),
                status: word(&row.status)?,
                summary: parsed(row.summary.as_deref())?,
                batch_number: row.batch_number,
                source_type: row.source_type,
                source_label: row.source_label,
                created_at: row.created_at,
                updated_at: row.updated_at,
                last_priced_at: row.last_priced_at,
                successful_count: row.successful_count.into(),
                manual_review_count: row.manual_review_count.into(),
                item_count: row.item_count.into(),
            })
        })
        .collect()
}

/// The newest 100 batches made by hand: from the Inventory Manager, a seller or a CSV.
pub async fn list(db: &Database) -> Result<Vec<Batch>, String> {
    let rows: Vec<BatchRow> = sqlx::query_as(&format!(
        "{BATCH_SELECT} WHERE b.source_type = ANY($1::text[]) {BATCH_GROUP}
         ORDER BY b.batch_number DESC LIMIT 100"
    ))
    .bind(["pending_inventory", "seller", "csv"])
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())?;
    with_jobs(db, rows).await
}

pub async fn one(db: &Database, batch: i32) -> Result<Batch, String> {
    let row: Option<BatchRow> = sqlx::query_as(&format!(
        "{BATCH_SELECT} WHERE b.batch_number = $1 {BATCH_GROUP}"
    ))
    .bind(batch)
    .fetch_optional(&db.0)
    .await
    .map_err(|e| e.to_string())?;
    let row = row.ok_or_else(|| format!("Batch {batch} not found"))?;
    with_jobs(db, vec![row])
        .await?
        .pop()
        .ok_or_else(|| format!("Batch {batch} not found"))
}

/// The batch's publications, newest first, and what publishing its completed pricing job would
/// send under the saved policy (`api.inventory-batch-publications` loader).
pub async fn publications(db: &Database, batch: i32) -> Result<Publications, String> {
    let e = |e: sqlx::Error| e.to_string();
    let mut conn = db.0.acquire().await.map_err(e)?;
    let (found, items, results) = preview::load(&mut conn, batch)
        .await
        .map_err(e)?
        .ok_or_else(|| format!("Batch {batch} not found"))?;
    let rows: Vec<(i64, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT id, planning_key, pricing_job_id, status FROM inventory_publications
         WHERE batch_number = $1 ORDER BY created_at DESC, id DESC",
    )
    .bind(batch)
    .fetch_all(&mut *conn)
    .await
    .map_err(e)?;
    let ids: Vec<i64> = rows.iter().map(|row| row.0).collect();
    let item_statuses: Vec<(i64, String)> = sqlx::query_as(
        "SELECT publication_id, status FROM inventory_publication_items
         WHERE publication_id = ANY($1) ORDER BY id",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(e)?;
    let publications = rows
        .into_iter()
        .map(|(id, planning_key, pricing_job_id, status)| Publication {
            items: item_statuses
                .iter()
                .filter(|(publication, _)| *publication == id)
                .map(|(_, status)| PublicationItem {
                    status: status.clone(),
                })
                .collect(),
            id,
            planning_key,
            pricing_job_id,
            status,
        })
        .collect();
    let preview = if found.job_status.as_deref() == Some("completed") {
        let policy = Configuration::load(&mut conn).await.map_err(e)?.policy;
        let known = preview::known(&mut conn, batch, &items, &results, None)
            .await
            .map_err(e)?;
        let shown = preview::preview(&found, &items, &results, &known, &policy, Utc::now(), false)?;
        Some(Preview::of(shown))
    } else {
        None
    };
    Ok(Publications {
        preview,
        publications,
    })
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

    /// `findResults`'s filter on the saved result's status.
    fn filter(self) -> &'static str {
        match self {
            Scope::Successful => "r.result_status = 'successful'",
            Scope::ManualReview => "r.result_status <> 'successful'",
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

/// `findResults`: the saved rows in `scope`, by product line, set, product and SKU. Each row is
/// read as text, so its columns keep the order Postgres gives them, which the CSV header follows.
pub async fn results(db: &Database, batch: i32, scope: Scope) -> Result<Vec<Row>, String> {
    let rows: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT r.row_json::text FROM inventory_batch_results r
         WHERE r.batch_number = $1 AND {}
         ORDER BY COALESCE(r.row_json->>'Product Line', ''), COALESCE(r.row_json->>'Set Name', ''),
           COALESCE(r.row_json->>'Product', ''), r.sku",
        scope.filter()
    ))
    .bind(batch)
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| serde_json::from_str(row).map_err(|e| e.to_string()))
        .collect()
}

/// The rows as CSV the way the React screen wrote them (Papa Parse): the first row's columns as
/// the header.
pub fn csv(rows: &[Row]) -> String {
    let Some(first) = rows.first() else {
        return String::new();
    };
    let header: Vec<&str> = first.0.iter().map(|(name, _)| name.as_str()).collect();
    let lines = rows.iter().map(|row| {
        header
            .iter()
            .map(|name| {
                row.0
                    .iter()
                    .find(|(n, _)| n == name)
                    .map_or_else(String::new, |(_, v)| v.clone())
            })
            .collect()
    });
    crate::csv_text::unparse(&header, lines)
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

/// `deleteBatch`: the batch with its items, results and pricing jobs. The database refuses a
/// published batch (its publications keep it).
pub async fn delete(db: &Database, batch: i32) -> Result<(), String> {
    let deleted = sqlx::query("DELETE FROM inventory_batches WHERE batch_number = $1")
        .bind(batch)
        .execute(&db.0)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if deleted == 0 {
        return Err(format!("Batch {batch} not found"));
    }
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

    #[derive(Deserialize)]
    struct Saved {
        row: Row,
    }

    /// The batches, each one shown, and the saved results of the newest priced ones, read here
    /// and from the running dev Node app's `/api/inventory-batches` routes: the same.
    #[tokio::test]
    #[ignore = "reads the dev database and the dev Node app"]
    async fn batches_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let legacy = Legacy::new(crate::config::legacy_origin());
        let ours = list(&db).await.unwrap();
        let theirs: Vec<Batch> = legacy.read("/api/inventory-batches").await.unwrap();
        assert_eq!(ours.len(), theirs.len());
        for (ours, theirs) in ours.iter().zip(&theirs) {
            assert_eq!(ours, theirs, "batch {}", ours.batch_number);
        }
        assert!(!ours.is_empty());
        for batch in ours.iter().take(10) {
            let n = batch.batch_number;
            let theirs: Batch = legacy
                .read(&format!("/api/inventory-batches/{n}"))
                .await
                .unwrap();
            assert_eq!(one(&db, n).await.unwrap(), theirs);
        }
        let priced = ours.iter().filter(|b| b.has_results()).take(3);
        for batch in priced {
            let n = batch.batch_number;
            for (scope, query) in [
                (Scope::Successful, "successful"),
                (Scope::ManualReview, "manual-review"),
            ] {
                let theirs: Vec<Saved> = legacy
                    .read(&format!("/api/inventory-batches/{n}/results?scope={query}"))
                    .await
                    .unwrap();
                let theirs: Vec<Row> = theirs.into_iter().map(|s| s.row).collect();
                let ours = results(&db, n, scope).await.unwrap();
                assert_eq!(csv(&ours), csv(&theirs), "batch {n} {query}");
            }
        }
        assert_eq!(
            one(&db, i32::MAX).await,
            Err(format!("Batch {} not found", i32::MAX))
        );
    }

    /// Each batch's publications and publication preview, read here and from the running dev Node
    /// app: the same, for the newest batches, the newest with publications and the newest with a
    /// publication in each status.
    #[tokio::test]
    #[ignore = "reads the dev database and the dev Node app"]
    async fn publications_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let legacy = Legacy::new(crate::config::legacy_origin());
        let published: Vec<i32> = sqlx::query_scalar(
            "(SELECT batch_number FROM inventory_publications WHERE batch_number IS NOT NULL
              ORDER BY batch_number DESC LIMIT 15)
             UNION
             (SELECT DISTINCT ON (status) batch_number FROM inventory_publications
              WHERE batch_number IS NOT NULL ORDER BY status, batch_number DESC)",
        )
        .fetch_all(&db.0)
        .await
        .unwrap();
        let mut numbers: Vec<i32> = list(&db)
            .await
            .unwrap()
            .iter()
            .take(15)
            .map(|b| b.batch_number)
            .collect();
        numbers.extend(published);
        numbers.sort_unstable();
        numbers.dedup();
        let mut previewed = 0;
        for n in numbers {
            let theirs: Publications = legacy
                .read(&format!("/api/inventory-batches/{n}/publications"))
                .await
                .unwrap();
            let ours = publications(&db, n).await.unwrap();
            previewed += usize::from(ours.preview.is_some());
            assert_eq!(ours, theirs, "batch {n}");
        }
        assert!(previewed > 0);
        assert_eq!(
            publications(&db, i32::MAX).await,
            Err(format!("Batch {} not found", i32::MAX))
        );
    }

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
