//! Reviewing a listing's price change: a preview saved with the listing and its evidence, then a
//! dry run of its publication against the imported inventory (`dry_run`). A preview is prepared
//! here, and it, its conflicts, its runs and their steps are read here. Neither contacts eBay:
//! seller OAuth and live readback are not connected, so nothing publishes.
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use corten::UrlValue;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    inventory::{self, Listing},
    recommendation,
};
use crate::database::Database;

/// A saved price-change preview, and why it would need replacing now.
#[derive(Clone, Debug, Deserialize)]
pub struct Preview {
    pub id: String,
    pub plan: Plan,
    pub conflicts: Vec<String>,
}

/// The price change as it was saved: the listing, the old and new item price, and what it rests on.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub inventory: PlanInventory,
    pub recommendation_id: String,
    pub old_price: Amount,
    pub new_price: Amount,
    pub change_percent: f64,
    /// `calculated` or `reviewed`.
    pub selection: String,
    pub identity: PlanIdentity,
    pub created_at: String,
    pub expires_at: String,
    pub evidence: Vec<serde_json::Value>,
    pub r#override: Option<PlanOverride>,
    pub flags: Vec<String>,
    pub policy_version: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInventory {
    pub id: String,
    pub item_id: String,
    #[serde(default)]
    pub variation_key: String,
    pub seller: String,
    pub revision: i64,
    pub snapshot: PlanSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanSnapshot {
    pub title: String,
    pub quantity: i64,
    pub format: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Amount {
    pub amount: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIdentity {
    pub slab_id: Option<String>,
    pub revision: i64,
}

/// The reviewed ask the preview was prepared from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOverride {
    pub item_price: Option<f64>,
    pub currency: Option<String>,
    pub note: String,
    pub reviewed_at: Option<String>,
}

impl Plan {
    /// Its review time is over, which its `preview-expired` conflict also says once it is read.
    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .parse::<DateTime<Utc>>()
            .map_or(true, |at| at <= now)
    }

    /// `+12.5%` or `-3.0%`.
    pub fn change(&self) -> String {
        let sign = if self.change_percent > 0.0 { "+" } else { "" };
        format!("{sign}{:.1}%", self.change_percent)
    }
}

/// One publication of a preview: its mode (`dry-run` or `live`), where it stands and why.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub state: String,
    pub reason: Option<String>,
    pub mode: String,
    pub created_at: String,
}

impl Run {
    /// A dry run stopped before it finished, which the same intent picks up again.
    pub fn resumable(&self) -> bool {
        self.mode == "dry-run" && matches!(self.state.as_str(), "approved" | "checking")
    }
}

/// A step a publication recorded, latest first.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub state: String,
    pub reason: Option<String>,
    pub created_at: String,
}

/// The listing's latest preview, its last publications, and the steps of the one asked about.
#[derive(Clone, Debug, Default)]
pub struct Review {
    pub preview: Option<Preview>,
    pub runs: Vec<Run>,
    /// The publication whose steps are shown, when it is one of this preview's.
    pub steps: Option<(String, Vec<Step>)>,
}

/// The most publications the panel lists.
const MOST_RUNS: i64 = 5;

/// The publication policy previews are prepared under (`SLAB_PUBLICATION_POLICY`).
const POLICY: &str = "reviewed-price-v1";

/// What a preview's conflicts read of its recommendation as it stands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    current: bool,
    calculation: StoredCalculation,
    r#override: Option<StoredOverride>,
}

#[derive(Deserialize)]
struct StoredCalculation {
    identity: PlanIdentityRevision,
}

#[derive(Deserialize)]
struct PlanIdentityRevision {
    revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOverride {
    item_price: f64,
    currency: String,
    note: String,
    reviewed_at: String,
}

pub(super) fn time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// `previewConflicts`: why the saved preview no longer matches the listing, its recommendation or
/// the reviewed ask, as of `now`.
fn conflicts(
    plan: &Plan,
    inventory: Option<&Listing>,
    recommendation: Option<&Stored>,
    now: DateTime<Utc>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let before = time(&plan.created_at).is_some_and(|at| now < at);
    let after = time(&plan.expires_at).is_some_and(|at| now >= at);
    if before || after {
        reasons.push("preview-expired");
    }
    if plan.version != POLICY {
        reasons.push("publication-policy-changed");
    }
    let saved = &plan.inventory;
    let listing_matches = inventory.is_some_and(|l| {
        l.id == saved.id
            && l.revision == saved.revision
            && l.seller == saved.seller
            && l.item_id == saved.item_id
            && l.variation_key == saved.variation_key
            && l.identity_id == plan.identity.slab_id
            && l.state == "active"
            && l.review_reasons.iter().all(|r| r == "certificate-required")
    });
    if !listing_matches {
        reasons.push("inventory-changed");
    }
    let recommendation_matches = recommendation.is_some_and(|r| {
        r.id == plan.recommendation_id
            && r.current
            && r.calculation.identity.revision == plan.identity.revision
    });
    if !recommendation_matches {
        reasons.push("recommendation-changed");
    }
    if plan.selection == "reviewed" {
        let reviewed = recommendation.and_then(|r| r.r#override.as_ref());
        let same = match (reviewed, &plan.r#override) {
            (Some(now), Some(then)) => {
                then.item_price == Some(now.item_price)
                    && then.currency.as_deref() == Some(now.currency.as_str())
                    && then.note == now.note
                    && then.reviewed_at.as_deref() == Some(now.reviewed_at.as_str())
            }
            _ => false,
        };
        if !same {
            reasons.push("reviewed-ask-changed");
        }
    }
    reasons.into_iter().map(str::to_owned).collect()
}

pub(super) fn is_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// Which saved preview `readPublicationPreview` reads.
#[derive(Clone, Copy)]
pub(super) enum Which<'a> {
    /// The listing's latest.
    Latest(&'a str),
    /// The preview of this id.
    Id(&'a str),
}

/// `readPublicationPreview`: the preview, its plan as saved, and why it would need replacing.
pub(super) async fn saved_preview(
    conn: &mut PgConnection,
    which: Which<'_>,
    now: DateTime<Utc>,
) -> Result<Option<(Preview, Value)>, String> {
    let failed = |e: sqlx::Error| e.to_string();
    let (query, id) = match which {
        Which::Latest(listing) => (
            "SELECT id::text, plan FROM slab_publication_previews WHERE inventory_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1",
            listing,
        ),
        Which::Id(id) => (
            "SELECT id::text, plan FROM slab_publication_previews WHERE id = $1::uuid",
            id,
        ),
    };
    if !is_id(id) {
        return Err("Choose a saved preview or listing.".to_owned());
    }
    let row: Option<(String, Value)> = sqlx::query_as(query)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
    let Some((id, saved)) = row else {
        return Ok(None);
    };
    let plan: Plan = serde_json::from_value(saved.clone())
        .map_err(|e| format!("The saved preview could not be read: {e}"))?;
    let inventory = inventory::listing(conn, &plan.inventory.id).await?;
    if !is_id(&plan.recommendation_id) {
        return Err("Choose a recommendation.".to_owned());
    }
    let stored: Option<Value> = sqlx::query_scalar(recommendation::BY_ID)
        .bind(&plan.recommendation_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
    let stored: Option<Stored> = stored
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| format!("The preview's recommendation could not be read: {e}"))?;
    let preview = Preview {
        conflicts: conflicts(&plan, inventory.as_ref(), stored.as_ref(), now),
        id,
        plan,
    };
    Ok(Some((preview, saved)))
}

/// The listing's latest preview, and why it would need replacing.
async fn preview(
    conn: &mut PgConnection,
    listing: &str,
    now: DateTime<Utc>,
) -> Result<Option<Preview>, String> {
    let read = saved_preview(conn, Which::Latest(listing), now).await?;
    Ok(read.map(|(preview, _)| preview))
}

/// Which ask a preview prices the listing at, as the select and the saved preview spell it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue)]
#[serde(rename_all = "lowercase")]
pub enum Selection {
    Calculated,
    Reviewed,
}

/// What the operator asked to preview (`PreviewRequest`): the listing and recommendation at the
/// revisions shown, and which ask, under an intent id that coalesces a post sent again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub intent_id: String,
    pub inventory_id: String,
    pub inventory_revision: i64,
    pub recommendation_id: String,
    /// `calculated` or `reviewed`.
    pub selection: String,
    /// When the reviewed ask chosen was reviewed; only kept for a reviewed selection.
    pub override_reviewed_at: Option<String>,
}

/// Why a preview is refused.
const REQUEST: &str = "Select a saved recommendation and the current listing revision.";
const USED: &str = "This preview intent was already used for a different selection.";
const UNAVAILABLE: &str = "Unable to access the price-change preview.";
const CHANGED: &str =
    "The listing, identity or recommendation changed. Reopen the listing and recalculate.";

/// The longest a preview stays reviewable, unless its evidence expires sooner.
const REVIEW_MS: i64 = 15 * 60_000;

/// The largest plan saved, in bytes of JSON.
const MOST_PLAN_BYTES: usize = 64 * 1024;

/// A time as `Date.parse` reads an ISO one, in milliseconds.
pub(super) fn millis(value: &str) -> Option<i64> {
    time(value).map(|t| t.timestamp_millis())
}

/// The milliseconds as `Date.prototype.toISOString` writes them.
pub(super) fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map_or_else(String::new, |t| {
            t.to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

/// A number as JavaScript keeps it: whole ones are written without a fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// JavaScript's `===` between two saved numbers, either of which may be null.
fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a.is_null() && b.is_null(),
    }
}

/// JavaScript's truthiness of a saved value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `previewRequest`: the request with only what a selection uses, or why it is refused.
fn checked(asked: &Asked) -> Result<Asked, String> {
    let reviewed = asked.selection == "reviewed";
    let valid = [
        &asked.intent_id,
        &asked.inventory_id,
        &asked.recommendation_id,
    ]
    .iter()
    .all(|id| is_id(id))
        && asked.inventory_revision >= 1
        && asked.inventory_revision <= 9_007_199_254_740_991
        && (reviewed || asked.selection == "calculated")
        && (!reviewed
            || asked
                .override_reviewed_at
                .as_deref()
                .and_then(millis)
                .is_some());
    if !valid {
        return Err(REQUEST.to_owned());
    }
    Ok(Asked {
        override_reviewed_at: asked.override_reviewed_at.clone().filter(|_| reviewed),
        ..asked.clone()
    })
}

/// Whether a saved request asked for exactly this: each of this request's keys has the same JSON
/// value in the saved one.
fn asked_the_same(saved: &Value, asked: &Asked) -> bool {
    let Ok(Value::Object(ours)) = serde_json::to_value(asked) else {
        return false;
    };
    ours.iter()
        .all(|(key, value)| saved.get(key) == Some(value))
}

/// `cents`: a USD amount in whole cents, positive and under a billion.
fn cents(value: &Value) -> Result<i64, String> {
    match value.as_f64() {
        Some(v) if v > 0.0 && v < 1e9 && (v * 100.0 - (v * 100.0).round()).abs() <= 1e-5 => {
            Ok((v * 100.0).round() as i64)
        }
        _ => Err("The selected USD item price must be positive and use whole cents.".to_owned()),
    }
}

/// The listing as `buildPublicationPreview` reads it: reviewed, with its source and its snapshot
/// as saved.
struct Imported {
    listing: Listing,
    source: String,
    snapshot: Value,
}

/// `buildPublicationPreview`: the price change of the listing to the selected ask, with what it
/// rests on, reviewable until `now` plus 15 minutes or its evidence's first expiry; or why the
/// listing, recommendation or ask cannot be previewed.
fn plan_of(
    asked: &Asked,
    imported: &Imported,
    recommendation: &Value,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let refuse = |why: &str| Err(why.to_owned());
    let (listing, snapshot) = (&imported.listing, &imported.snapshot);
    let now = now.timestamp_millis();
    let calculation = &recommendation["calculation"];
    let market = &calculation["market"];
    let seller = &calculation["seller"];
    let identity = &calculation["identity"];
    let dated_later = calculation["market"]["asOf"]
        .as_str()
        .and_then(millis)
        .is_some_and(|as_of| now < as_of);
    if dated_later
        || listing.id != asked.inventory_id
        || listing.revision != asked.inventory_revision
        || recommendation["id"].as_str() != Some(asked.recommendation_id.as_str())
        || recommendation["current"] != Value::Bool(true)
        || listing.identity_id.as_deref() != identity["slabId"].as_str()
    {
        return refuse(CHANGED);
    }
    let evidence = calculation["evidence"].as_array();
    if calculation["policyVersion"] != "slab-policy-v1"
        || !truthy(&market["range"])
        || evidence.is_none_or(Vec::is_empty)
    {
        return refuse("Use a supported recommendation with adequate direct sales evidence.");
    }
    let evidence = evidence.map(Vec::as_slice).unwrap_or_default();
    if listing.state != "active"
        || snapshot["state"] != "active"
        || snapshot["quantity"].as_f64() != Some(1.0)
        || snapshot["format"] != "fixed-price"
    {
        return refuse("Only active, single-quantity fixed-price slabs can be previewed.");
    }
    if !listing.variation_key.is_empty() || truthy(&snapshot["variationKey"]) {
        return refuse(
            "Variation listings need a verified variation publisher and remain in review.",
        );
    }
    if listing
        .review_reasons
        .iter()
        .any(|r| r != "certificate-required")
    {
        return refuse("Resolve the listing's review reasons before preparing its price change.");
    }
    let (price, shipping) = (&snapshot["price"], &snapshot["shipping"]);
    if price["currency"] != "USD"
        || calculation["policy"]["currency"] != "USD"
        || !same(&seller["currentAsk"], &price["amount"])
        || !same(&seller["shippingCharged"], &shipping["amount"])
        || (!shipping["amount"].is_null() && shipping["currency"] != "USD")
    {
        return refuse("Recalculate using this listing's current USD price and shipping charge.");
    }
    let reviewed = asked.selection == "reviewed";
    let r#override = if reviewed {
        &recommendation["override"]
    } else {
        &Value::Null
    };
    if reviewed
        && (r#override.is_null()
            || r#override["reviewedAt"].as_str() != asked.override_reviewed_at.as_deref()
            || r#override["currency"] != "USD")
    {
        return refuse("The reviewed ask changed. Reload it before preparing the price change.");
    }
    let amount = match &r#override["itemPrice"] {
        Value::Null => &calculation["ask"]["proposedItemAsk"],
        price => price,
    };
    if amount.is_null() {
        return refuse("This recommendation has no item ask to publish.");
    }
    let (old, new) = (cents(&price["amount"])?, cents(amount)?);
    if old == new {
        return refuse("The selected ask already matches the imported listing price.");
    }
    let lowest = serde_json::from_value::<recommendation::Seller>(seller.clone())
        .ok()
        .and_then(|s| s.lowest_ask());
    let below = |floor: f64| (new as f64) < (floor * 100.0 - 1e-9).ceil();
    if lowest.is_none_or(|floor| !floor.is_finite() || below(floor)) {
        return refuse("The selected ask does not satisfy the saved seller constraints.");
    }
    let expiry = evidence
        .iter()
        .map(|e| e["expiresAt"].as_str().and_then(millis))
        .try_fold(now + REVIEW_MS, |soonest, at| at.map(|at| soonest.min(at)));
    let Some(expiry) = expiry.filter(|&at| at > now) else {
        return refuse("The selected sales evidence expired. Refresh and recalculate.");
    };
    let mut flags: Vec<Value> = Vec::new();
    let raised = market["flags"]
        .as_array()
        .into_iter()
        .chain(calculation["ask"]["flags"].as_array())
        .flatten()
        .map(|flag| flag["code"].clone());
    let change = (new - old).abs() as f64 / old as f64;
    let large = calculation["policy"]["reviewChangeFraction"]
        .as_f64()
        .is_some_and(|most| change > most);
    for code in raised.chain(large.then(|| json!("large-change-from-current-ask"))) {
        if !flags.contains(&code) {
            flags.push(code);
        }
    }
    // JSON.stringify leaves out keys that are undefined.
    let kept = |e: &Value, keys: &[&str]| {
        let picked: serde_json::Map<String, Value> = keys
            .iter()
            .filter_map(|k| e.get(*k).map(|v| ((*k).to_owned(), v.clone())))
            .collect();
        Value::Object(picked)
    };
    Ok(json!({
        "version": POLICY,
        "mode": "preview",
        "inventory": {
            "id": listing.id,
            "revision": listing.revision,
            "seller": listing.seller,
            "itemId": listing.item_id,
            "variationKey": listing.variation_key,
            "source": imported.source,
            "observedAt": listing.observed_at,
            "snapshot": snapshot,
        },
        "recommendationId": asked.recommendation_id,
        "identity": identity,
        "policyVersion": calculation["policyVersion"],
        "policy": calculation["policy"],
        "sellerConstraints": seller,
        "evidence": evidence.iter().map(|e| kept(e, &["revisionId", "expiresAt"])).collect::<Vec<_>>(),
        "selection": asked.selection,
        "override": r#override,
        "oldPrice": { "amount": js_number(old as f64 / 100.0), "currency": "USD" },
        "newPrice": { "amount": js_number(new as f64 / 100.0), "currency": "USD" },
        "changePercent": js_number((new - old) as f64 / old as f64 * 100.0),
        "flags": flags,
        "createdAt": iso(now),
        "expiresAt": iso(expiry),
    }))
}

/// `preparePublicationPreview`: saves the price-change preview of the listing and recommendation
/// asked for, under its intent id, and clears previews expired a month without a publication.
/// The same intent asked again is its saved preview; asked for something else, it is refused.
/// Returns the preview's id.
pub async fn prepare(
    conn: &mut PgConnection,
    asked: &Asked,
    now: DateTime<Utc>,
) -> Result<String, String> {
    let asked = checked(asked)?;
    let failed = |error: sqlx::Error| {
        eprintln!("slab publication preview: {error}");
        UNAVAILABLE.to_owned()
    };
    let previous: Option<Value> =
        sqlx::query_scalar("SELECT request FROM slab_publication_previews WHERE id = $1::uuid")
            .bind(&asked.intent_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(failed)?;
    if let Some(previous) = previous {
        return if asked_the_same(&previous, &asked) {
            Ok(asked.intent_id)
        } else {
            Err(USED.to_owned())
        };
    }
    let listing = inventory::listing(conn, &asked.inventory_id)
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?;
    let saved: Option<(String, Value)> =
        sqlx::query_as("SELECT source, snapshot FROM slab_inventory WHERE id = $1::uuid")
            .bind(&asked.inventory_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(failed)?;
    let recommendation: Option<Value> = sqlx::query_scalar(recommendation::BY_ID)
        .bind(&asked.recommendation_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
    let (Some(listing), Some((source, snapshot)), Some(recommendation)) =
        (listing, saved, recommendation)
    else {
        return Err("The listing or recommendation no longer exists.".to_owned());
    };
    let imported = Imported {
        listing,
        source,
        snapshot,
    };
    let plan = plan_of(&asked, &imported, &recommendation, now)?;
    if plan.to_string().len() > MOST_PLAN_BYTES {
        return Err("This listing exceeds the saved preview size limit.".to_owned());
    }
    let expires_at = plan["expiresAt"].as_str().and_then(time);
    let mut tx = conn.begin().await.map_err(failed)?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    // The intent id coalesces a post sent again; a reviewed plan is never replaced.
    let (id, request): (String, Value) = sqlx::query_as(
        "INSERT INTO slab_publication_previews(id,inventory_id,recommendation_id,request,plan,expires_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING id::text,request",
    )
    .bind(&asked.intent_id)
    .bind(&asked.inventory_id)
    .bind(&asked.recommendation_id)
    .bind(json!(asked))
    .bind(&plan)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    sqlx::query(
        "DELETE FROM slab_publication_previews WHERE id IN (SELECT p.id FROM slab_publication_previews p WHERE expires_at<clock_timestamp()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM slab_publications s WHERE s.preview_id=p.id) ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)",
    )
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    if asked_the_same(&request, &asked) {
        Ok(id)
    } else {
        Err(USED.to_owned())
    }
}

/// A publication as listed: its id, state, why, mode and when it was prepared.
type RunRow = (String, String, Option<String>, String, DateTime<Utc>);

/// The preview's latest publications (`publicationHistory`).
async fn runs(conn: &mut PgConnection, preview: &str) -> Result<Vec<Run>, String> {
    let rows: Vec<RunRow> = sqlx::query_as(
        "SELECT id::text, state, reason, mode, created_at FROM slab_publications WHERE preview_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT $2",
    )
    .bind(preview)
    .bind(MOST_RUNS)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, state, reason, mode, at)| Run {
            id,
            state,
            reason,
            mode,
            created_at: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .collect())
}

/// A publication's steps, latest first (`publicationEvents`).
async fn steps_of(conn: &mut PgConnection, publication: &str) -> Result<Vec<Step>, String> {
    let rows: Vec<(String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT state, reason, created_at FROM slab_publication_events WHERE publication_id = $1::uuid ORDER BY sequence DESC LIMIT 50",
    )
    .bind(publication)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(state, reason, at)| Step {
            state,
            reason,
            created_at: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .collect())
}

async fn review(
    conn: &mut PgConnection,
    listing: &str,
    steps: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Review, String> {
    let Some(preview) = preview(conn, listing, now).await? else {
        return Ok(Review::default());
    };
    let runs = runs(conn, &preview.id).await?;
    let steps = match steps.filter(|id| runs.iter().any(|r| r.id == *id)) {
        Some(id) => Some((id.to_owned(), steps_of(conn, id).await?)),
        None => None,
    };
    Ok(Review {
        preview: Some(preview),
        runs,
        steps,
    })
}

/// The listing's price-change review, with the steps of `steps` when it is one of its runs.
pub async fn read(db: &Database, listing: &str, steps: Option<&str>) -> Result<Review, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    review(&mut conn, listing, steps, Utc::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(change: f64, expires: &str) -> Plan {
        serde_json::from_value(serde_json::json!({
            "recommendationId": "r", "inventory": { "id": "i", "itemId": "1", "seller": "s", "revision": 2,
                "snapshot": { "title": "t", "quantity": 1, "format": "fixed-price" } },
            "oldPrice": { "amount": 100.0 }, "newPrice": { "amount": 112.5 },
            "changePercent": change, "selection": "calculated", "identity": { "slabId": "s", "revision": 1 },
            "createdAt": "2026-10-30T00:00:00Z", "expiresAt": expires, "evidence": [{}],
            "override": null, "flags": [], "policyVersion": "slab-policy-v1",
            "version": "reviewed-price-v1"
        }))
        .unwrap()
    }

    #[test]
    fn a_plan_expires_at_its_time() {
        let now: DateTime<Utc> = "2026-10-30T00:10:00Z".parse().unwrap();
        assert!(!plan(1.0, "2026-10-30T00:15:00Z").expired(now));
        assert!(plan(1.0, "2026-10-30T00:10:00Z").expired(now));
        assert!(plan(1.0, "not a date").expired(now));
    }

    #[test]
    fn a_change_is_signed_as_the_react_panel_wrote_it() {
        assert_eq!(plan(12.5, "").change(), "+12.5%");
        assert_eq!(plan(-3.0, "").change(), "-3.0%");
        assert_eq!(plan(0.0, "").change(), "0.0%");
    }

    #[test]
    fn only_a_stopped_dry_run_resumes() {
        let run = |mode: &str, state: &str| Run {
            id: "r".into(),
            state: state.into(),
            reason: None,
            mode: mode.into(),
            created_at: String::new(),
        };
        assert!(run("dry-run", "checking").resumable());
        assert!(run("dry-run", "approved").resumable());
        assert!(!run("dry-run", "dry-run").resumable());
        assert!(!run("live", "checking").resumable());
    }
}
