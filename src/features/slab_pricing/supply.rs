//! Active supply for the slab researched: the unsold listings a provider reports, screened
//! against the identity (equivalent, potential match, excluded), with the lowest delivered asks
//! and what changed since the scan before. Context only: it never changes the recommendation.
//! Read here (`loadSlabSupply`, `describeSupply`, `compareSupplyScans`); refreshing stays the
//! Node app's (`/api/slab-supply`), whose worker calls eBay and Alt. Node's read also woke its
//! in-process evidence worker while a refresh was queued; this process cannot, so the worker must
//! be running on its own.
use std::collections::{BTreeSet, HashSet};

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;

use super::{
    inventory::seller_account,
    research::{self, EvidenceStatus, Grading, Window},
    screening::{Described, Severity, compare_identity},
};
use crate::{
    database::Database,
    features::slab_evidence::{
        spec::{EbayPage, Spec as Request},
        store,
    },
    row_order::Key,
};

/// Supply rows a page, as the Node app pages them.
pub const ROWS: u32 = 50;

/// A column the supply rows can be sorted by. As the React grid did, a sort orders the rows
/// shown, not every page of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, corten::UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupplyColumn {
    Listing,
    Item,
    Shipping,
    Delivered,
    Age,
    Comparison,
    Reasons,
}

impl SupplyColumn {
    /// The columns in the table's order, with their headers.
    pub const ALL: [(SupplyColumn, &'static str); 7] = [
        (SupplyColumn::Listing, "Active listing"),
        (SupplyColumn::Item, "Item ask / bid"),
        (SupplyColumn::Shipping, "Shipping"),
        (SupplyColumn::Delivered, "Delivered (USD)"),
        (SupplyColumn::Age, "Listing age"),
        (SupplyColumn::Comparison, "Comparison"),
        (SupplyColumn::Reasons, "Review reasons"),
    ];

    /// What `row` sorts by in this column: the cell's `data-sort` or its text, as the table
    /// draws it. An unknown amount or age sorts last.
    pub(super) fn key(self, row: &Row) -> Option<Key> {
        let text = |t: String| (!t.trim().is_empty()).then_some(Key::Text(t));
        let listing = &row.listing;
        match self {
            SupplyColumn::Listing => text(
                listing
                    .title
                    .clone()
                    .unwrap_or_else(|| listing.provider_id.clone()),
            ),
            SupplyColumn::Item => listing.price.as_ref().map(|m| Key::Number(m.amount)),
            SupplyColumn::Shipping => listing.shipping.as_ref().map(|m| Key::Number(m.amount)),
            SupplyColumn::Delivered => row.delivered_ask.map(Key::Number),
            SupplyColumn::Age => row.listing_age_days.map(Key::Number),
            SupplyColumn::Comparison => text(super::identity::words(&row.status)),
            SupplyColumn::Reasons => text(row.reasons()),
        }
    }
}

/// The seller whose own listings are left out of supply when no listing is reviewed.
pub const DEFAULT_SELLER: &str = "pokebash";

/// How old a scan may be before its asks stop counting as competition.
const FRESH_MS: i64 = 15 * 60 * 1000;

/// The most of a seller's item IDs a read leaves out.
const MOST_OWN_ITEMS: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supply {
    pub identity_revision: i64,
    pub statuses: Vec<EvidenceStatus>,
    pub selected_key: Option<String>,
    pub known_own_listings: u32,
    pub context: Option<Context>,
    pub changes: Option<Changes>,
    pub page: Option<Page>,
    pub source_has_more_pages: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub captured_at: String,
    pub reported_count: u32,
    /// The snapshot is old or its last refresh failed: its asks are not counted as competition.
    pub stale: bool,
    pub rows: Vec<Row>,
    pub equivalent_listings: u32,
    pub potential_listings: u32,
    pub excluded_listings: u32,
    pub lowest_equivalent_delivered_ask: Option<f64>,
    pub lowest_potential_delivered_ask: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    pub listing: Listing,
    /// `equivalent`, `potential-match` or `excluded`.
    pub status: String,
    pub reasons: Vec<String>,
    pub delivered_ask: Option<f64>,
    pub listing_age_days: Option<f64>,
}

/// One unsold listing a provider reported (`SupplyEvidence`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub extended_title: Option<String>,
    /// `alt` or `ebayResearch`.
    pub provider: String,
    pub provider_id: String,
    #[serde(default)]
    pub asset_id: Option<String>,
    pub source_url: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    pub price: Option<Money>,
    /// `ask`, `bid` or `unknown`.
    pub price_kind: String,
    pub shipping: Option<Money>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub items: Vec<Item>,
}

/// One slab in a listing, as the provider graded it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub asset_id: Option<String>,
    pub grading: Grading,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Money {
    pub amount: f64,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub observed_from: String,
    pub observed_through: String,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Change {
    pub key: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub offset: u32,
    pub total: u32,
    pub next_offset: Option<u32>,
}

impl Supply {
    pub fn pending(&self) -> bool {
        self.statuses.iter().any(EvidenceStatus::pending)
    }

    /// The saved revision of the source shown, which the next source page is fetched after.
    pub fn selected_revision(&self) -> Option<&str> {
        let key = self.selected_key.as_deref()?;
        self.statuses
            .iter()
            .find(|s| s.key == key)
            .and_then(|s| s.latest_revision.as_deref())
    }
}

impl Row {
    /// Its review reasons, as the table lists them.
    pub fn reasons(&self) -> String {
        self.reasons
            .iter()
            .map(|r| super::identity::words(r))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `3 days`, `<1 day`, or "Unknown", as the React grid wrote a listing's age.
    pub fn age(&self) -> String {
        match self.listing_age_days {
            None => "Unknown".into(),
            Some(days) if days < 1.0 => "<1 day".into(),
            Some(days) => format!("{} days", days.floor()),
        }
    }
}

impl Listing {
    /// `supplyListingKey`.
    fn key(&self) -> String {
        format!("{}:{}", self.provider, self.provider_id)
    }

    /// The eBay item the listing is, read from its link when the provider is not eBay.
    fn ebay_item_id(&self) -> Option<String> {
        if self.provider == "ebayResearch" && !self.provider_id.is_empty() {
            return Some(self.provider_id.clone());
        }
        let url = Url::parse(self.source_url.as_deref()?).ok()?;
        let host = url.host_str()?;
        if host != "ebay.com" && !host.ends_with(".ebay.com") {
            return None;
        }
        let rest = url.path().strip_prefix("/itm/")?;
        let digits = |text: &str| -> Option<String> {
            let number: String = text.chars().take_while(char::is_ascii_digit).collect();
            Some(number).filter(|n| !n.is_empty())
        };
        // `/^\/itm\/(?:[^/]+\/)?(\d+)/`: a slug segment may come first.
        match rest.split_once('/') {
            Some((slug, after)) if !slug.is_empty() => digits(after).or_else(|| digits(rest)),
            _ => digits(rest),
        }
    }
}

/// `USD 12.30`, `Unknown currency 12.30`, or "Unknown", as the React panel wrote a price.
pub fn money(value: Option<&Money>) -> String {
    match value {
        None => "Unknown".into(),
        Some(m) => format!(
            "{} {:.2}",
            m.currency.as_deref().unwrap_or("Unknown currency"),
            m.amount
        ),
    }
}

/// Which supply to read: the slab at a grade and dates, the seller whose own listings are left
/// out, the source chosen (none for the default), and the first row of the page.
pub struct Asked<'a> {
    pub id: &'a str,
    pub grade: &'a str,
    pub window: &'a Window,
    pub seller: &'a str,
    pub source: Option<&'a str>,
    pub offset: u32,
}

/// The saved supply for the slab, screened as the Node app screens it.
pub async fn read(db: &Database, asked: &Asked<'_>) -> Result<Supply, String> {
    let mut conn = db.0.acquire().await.map_err(unavailable)?;
    load(&mut conn, asked, Utc::now()).await
}

/// Node hid what went wrong with the database behind this.
fn unavailable(error: impl std::fmt::Display) -> String {
    eprintln!("slab supply: {error}");
    "Unable to load slab supply context.".to_owned()
}

/// `Date.parse` for the times providers and the database give: ISO times, or a bare day at UTC
/// midnight.
fn millis(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .map(|t| t.timestamp_millis())
        .ok()
        .or_else(|| {
            let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
            Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
        })
}

/// `loadSlabSupply` at `now`.
async fn load(
    conn: &mut PgConnection,
    asked: &Asked<'_>,
    now: DateTime<Utc>,
) -> Result<Supply, String> {
    let seller = seller_account(asked.seller)?;
    if asked.offset > 1950 || !asked.offset.is_multiple_of(ROWS) {
        return Err("Choose a bounded supply page.".to_owned());
    }
    let plan = research::plan(conn, asked.id, None, asked.grade, asked.window).await?;
    let keys = research::supply_keys(&plan.target, asked.window)?;
    let source = asked.source.filter(|key| !key.is_empty());
    let wanted: Vec<String> = keys
        .iter()
        .cloned()
        .chain(source.map(str::to_owned))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let found = store::statuses(&mut *conn, &wanted)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(source) = source.filter(|key| !keys.iter().any(|k| k == key)) {
        let first_page = |page: &EbayPage| {
            Request::EbaySupply(EbayPage {
                offset: 0,
                ..page.clone()
            })
            .key()
        };
        let belongs = found.iter().find(|s| s.key == source).is_some_and(|s| {
            matches!(&s.spec, Request::EbaySupply(page) if first_page(page).is_ok_and(|k| keys.contains(&k)))
        });
        if !belongs {
            return Err("This supply page belongs to another research context.".to_owned());
        }
    }
    let has_revision =
        |s: &&store::Status| s.latest_revision.as_deref().is_some_and(|r| !r.is_empty());
    let selected = found
        .iter()
        .find(|s| Some(s.key.as_str()) == source)
        .or_else(|| {
            found
                .iter()
                .filter(has_revision)
                .find(|s| matches!(s.spec, Request::EbaySupply(_)))
        })
        .or_else(|| found.iter().find(has_revision))
        .or(found.first())
        .map(|s| {
            (
                s.key.clone(),
                s.latest_revision.clone().filter(|r| !r.is_empty()),
                s.stale,
            )
        });
    let owned: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT item_id FROM slab_inventory WHERE seller = $1 LIMIT 10001",
    )
    .bind(&seller)
    .fetch_all(&mut *conn)
    .await
    .map_err(unavailable)?;
    if owned.len() > MOST_OWN_ITEMS {
        return Err("Supply context supports at most 10,000 known seller item IDs.".to_owned());
    }
    let mut supply = Supply {
        identity_revision: plan.revision,
        statuses: found.into_iter().map(research::status).collect(),
        selected_key: selected.as_ref().map(|(key, ..)| key.clone()),
        known_own_listings: owned.len() as u32,
        context: None,
        changes: None,
        page: None,
        source_has_more_pages: false,
    };
    let Some((key, Some(revision), stale)) = selected else {
        return Ok(supply);
    };
    let Some(saved) = saved_supply(conn, &revision).await? else {
        return Ok(supply);
    };
    let scan = Scan {
        source_key: key,
        captured_at: saved.as_of,
        complete: false,
        listings: saved.listings,
    };
    let previous = previous_scan(conn, &scan.source_key, &scan.captured_at).await?;
    let own: HashSet<String> = owned.into_iter().collect();
    let mut context = describe(&scan, &plan, &own, now, stale);
    let total = scan.listings.len();
    let last_page = ((total as i64 - 1).div_euclid(i64::from(ROWS)) * i64::from(ROWS)).max(0);
    let offset = i64::from(asked.offset).min(last_page) as usize;
    context.rows = context
        .rows
        .into_iter()
        .skip(offset)
        .take(ROWS as usize)
        .collect();
    supply.changes = previous.map(|p| compare(&p, &scan)).transpose()?;
    supply.page = Some(Page {
        offset: offset as u32,
        total: total as u32,
        next_offset: (offset + (ROWS as usize) < total).then_some((offset + ROWS as usize) as u32),
    });
    supply.source_has_more_pages = saved.more_pages;
    supply.context = Some(context);
    Ok(supply)
}

/// A supply scan: the listings a refresh read for a source, when.
struct Scan {
    source_key: String,
    captured_at: String,
    complete: bool,
    listings: Vec<Listing>,
}

/// A saved supply revision, its listings read from its scan.
struct Saved {
    as_of: String,
    listings: Vec<Listing>,
    /// eBay has more listings than the page read.
    more_pages: bool,
}

/// `getEvidenceRevision` for a supply revision: none when it is gone or is not supply.
async fn saved_supply(conn: &mut PgConnection, id: &str) -> Result<Option<Saved>, String> {
    type Record = (String, Value, Option<String>);
    let row: Option<Record> = sqlx::query_as(
        "SELECT key, payload, supply_scan_id::text FROM slab_evidence_revisions WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    let Some((key, payload, scan_id)) = row else {
        return Ok(None);
    };
    let kind = payload["kind"].as_str();
    let listings = match scan_id {
        Some(scan_id) => {
            let Some(scan) = scan(conn, &scan_id).await? else {
                return Ok(None);
            };
            if scan.source_key != key {
                return Err("Supply revision scope changed.".to_owned());
            }
            if !matches!(kind, Some("alt-supply" | "ebay-supply")) {
                return Err("Invalid supply revision.".to_owned());
            }
            scan.listings
        }
        None if matches!(kind, Some("alt-supply" | "ebay-supply")) => {
            serde_json::from_value(payload["data"]["listings"].clone()).map_err(unavailable)?
        }
        None => return Ok(None),
    };
    let data = &payload["data"];
    Ok(Some(Saved {
        as_of: data["asOf"].as_str().unwrap_or_default().to_owned(),
        listings,
        more_pages: kind == Some("ebay-supply")
            && data
                .get("page")
                .and_then(|page| page.get("nextOffset"))
                .is_none_or(|next| !next.is_null()),
    }))
}

/// `getSupplyScan`: the scan's listings in the order read.
async fn scan(conn: &mut PgConnection, id: &str) -> Result<Option<Scan>, String> {
    type Record = (String, DateTime<Utc>, bool, Value);
    let row: Option<Record> = sqlx::query_as(
        "SELECT s.source_key, s.captured_at, s.complete,
           COALESCE((SELECT jsonb_agg(v.payload ORDER BY o.position) FROM slab_supply_observations o
             JOIN slab_supply_versions v ON v.hash = o.version_hash WHERE o.scan_id = s.id), '[]'::jsonb)
         FROM slab_supply_scans s WHERE s.id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    let Some((source_key, captured_at, complete, listings)) = row else {
        return Ok(None);
    };
    Ok(Some(Scan {
        source_key,
        captured_at: captured_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        complete,
        listings: serde_json::from_value(listings).map_err(unavailable)?,
    }))
}

/// `previousSupplyScan`: the source's scan captured last before `before`.
async fn previous_scan(
    conn: &mut PgConnection,
    source_key: &str,
    before: &str,
) -> Result<Option<Scan>, String> {
    let id: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM slab_supply_scans WHERE source_key = $1 AND captured_at < $2::timestamptz
         ORDER BY captured_at DESC, id DESC LIMIT 1",
    )
    .bind(source_key)
    .bind(before)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    match id {
        Some(id) => scan(conn, &id).await,
        None => Ok(None),
    }
}

/// `screenCompetitorSupply`: why a listing's ask is not a competing one.
fn gate(
    listing: &Listing,
    own: &HashSet<String>,
    captured_at: Option<i64>,
    now: i64,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if listing.ebay_item_id().is_some_and(|id| own.contains(&id)) {
        reasons.push("own-current-listing");
    }
    if captured_at.is_none_or(|at| now < at || now - at > FRESH_MS) {
        reasons.push("supply-snapshot-stale");
    }
    match listing.price_kind.as_str() {
        "ask" => {}
        "bid" => reasons.push("auction-bid-is-not-an-ask"),
        _ => reasons.push("price-kind-unknown"),
    }
    let priced = listing.price.as_ref().is_some_and(|p| {
        p.currency.as_deref().is_some_and(|c| !c.is_empty())
            && p.amount.is_finite()
            && p.amount > 0.0
    });
    if !priced {
        reasons.push("asking-price-unresolved");
    }
    let active = listing.state.as_deref().is_some_and(|s| {
        ["active", "available", "live", "listed"]
            .iter()
            .any(|word| s.eq_ignore_ascii_case(word))
    });
    if !active {
        reasons.push("listing-not-confirmed-active");
    }
    reasons.into_iter().map(str::to_owned).collect()
}

/// `describeSupply`: each listing screened against the slab at the grade, and the lowest
/// delivered asks of the equivalent and potentially matching ones.
fn describe(
    scan: &Scan,
    plan: &research::Plan,
    own: &HashSet<String>,
    now: DateTime<Utc>,
    invalidated: bool,
) -> Context {
    let now = now.timestamp_millis();
    let captured_at = millis(&scan.captured_at);
    let stale = invalidated || captured_at.is_none_or(|at| now < at || now - at > FRESH_MS);
    let unknown = Grading {
        grader: "UNKNOWN".to_owned(),
        encoding: "unknown".to_owned(),
        number: None,
        label: None,
        qualifier: None,
        autograph: None,
    };
    let target = &plan.target;
    let rows: Vec<Row> = scan
        .listings
        .iter()
        .map(|listing| {
            let gated = gate(listing, own, captured_at, now);
            let single = match listing.items.as_slice() {
                [item] => Some(item),
                _ => None,
            };
            let linked = listing.provider == "alt"
                && target.provider_asset_id().is_some()
                && listing.asset_id.as_deref() == target.provider_asset_id()
                && single.is_some_and(|item| item.asset_id == listing.asset_id);
            let identity = if plan.status == "confirmed" {
                compare_identity(
                    &Described {
                        card: linked.then_some(&target.card),
                        grading: single.map_or(&unknown, |item| &item.grading),
                        title: &listing.title,
                        extended_title: &listing.extended_title,
                    },
                    target,
                )
            } else {
                Vec::new()
            };
            let mut reasons = gated.clone();
            if plan.status == "confirmed" {
                reasons.extend(identity.iter().map(|r| r.code.clone()));
            } else {
                reasons.push("target-identity-unconfirmed".to_owned());
            }
            if invalidated {
                reasons.push("supply-refresh-invalidated".to_owned());
            }
            let bundle = listing.items.len() > 1;
            if bundle {
                reasons.push("bundle-not-a-single-slab".to_owned());
            }
            let excluded = invalidated
                || !gated.is_empty()
                || bundle
                || identity.iter().any(|r| r.severity == Severity::Reject);
            let needs_review = plan.status != "confirmed" || !identity.is_empty();
            let status = if excluded {
                "excluded"
            } else if needs_review {
                "potential-match"
            } else {
                "equivalent"
            };
            let usd = |money: &Option<Money>| {
                money
                    .as_ref()
                    .filter(|m| m.currency.as_deref() == Some("USD") && m.amount.is_finite())
                    .map(|m| m.amount)
            };
            let delivered_ask = match (usd(&listing.price), usd(&listing.shipping)) {
                (Some(price), Some(shipping))
                    if listing.price_kind == "ask" && price > 0.0 && shipping >= 0.0 =>
                {
                    Some(price + shipping)
                }
                _ => None,
            };
            let started = listing.started_at.as_deref().and_then(millis);
            let listing_age_days = match (started, captured_at) {
                (Some(started), Some(captured)) if started <= captured => {
                    Some((captured - started) as f64 / 86_400_000.0)
                }
                _ => None,
            };
            Row {
                key: listing.key(),
                listing: listing.clone(),
                status: status.to_owned(),
                reasons,
                delivered_ask,
                listing_age_days,
            }
        })
        .collect();
    let lowest = |status: &str| {
        rows.iter()
            .filter(|r| r.status == status)
            .filter_map(|r| r.delivered_ask)
            .reduce(f64::min)
    };
    let count = |status: &str| rows.iter().filter(|r| r.status == status).count() as u32;
    let equivalent_listings = count("equivalent");
    let potential_listings = count("potential-match");
    Context {
        captured_at: scan.captured_at.clone(),
        reported_count: scan.listings.len() as u32,
        stale,
        excluded_listings: rows.len() as u32 - equivalent_listings - potential_listings,
        equivalent_listings,
        potential_listings,
        lowest_equivalent_delivered_ask: lowest("equivalent"),
        lowest_potential_delivered_ask: lowest("potential-match"),
        rows,
    }
}

/// `compareSupplyScans`: what each listing did between two scans of the same source. A listing
/// gone from a partial scan is not known to have sold.
fn compare(previous: &Scan, current: &Scan) -> Result<Changes, String> {
    let (from, through) = (millis(&previous.captured_at), millis(&current.captured_at));
    if previous.source_key != current.source_key
        || !matches!((from, through), (Some(from), Some(through)) if from < through)
    {
        return Err(unavailable(
            "Compare consecutive observations of the same supply scope.",
        ));
    }
    let keyed = |scan: &Scan| -> Vec<(String, Listing)> {
        scan.listings.iter().map(|l| (l.key(), l.clone())).collect()
    };
    // Node's Map keeps the last listing for a key.
    let find = |listings: &[(String, Listing)], key: &str| {
        listings
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, l)| l.clone())
    };
    let (before, after) = (keyed(previous), keyed(current));
    let keys: BTreeSet<&String> = before.iter().chain(&after).map(|(k, _)| k).collect();
    let price = |l: &Listing| {
        (
            l.price.as_ref().map(|p| p.amount),
            l.price.as_ref().and_then(|p| p.currency.clone()),
            l.price_kind.clone(),
            l.shipping.as_ref().map(|s| s.amount),
            l.shipping.as_ref().and_then(|s| s.currency.clone()),
        )
    };
    let items = |l: &Listing| {
        let mut items: Vec<String> = l
            .items
            .iter()
            .map(|i| {
                let g = &i.grading;
                serde_json::json!([
                    i.asset_id,
                    g.grader,
                    g.number,
                    g.label,
                    g.encoding,
                    g.qualifier,
                    g.autograph
                ])
                .to_string()
            })
            .collect();
        items.sort();
        items
    };
    let mut changes = Vec::new();
    for key in keys {
        let change = |kind: &str| Change {
            key: key.clone(),
            kind: kind.to_owned(),
        };
        match (find(&before, key), find(&after, key)) {
            (None, _) => changes.push(change("newly-observed")),
            (Some(_), None) => changes.push(change(if current.complete {
                "not-in-complete-scan"
            } else {
                "not-observed-in-partial-scan"
            })),
            (Some(a), Some(b)) => {
                if price(&a) != price(&b) {
                    changes.push(change("observed-price-change"));
                }
                if a.state != b.state || a.format != b.format {
                    changes.push(change("observed-availability-change"));
                }
                if a.quantity != b.quantity {
                    changes.push(change("observed-quantity-change"));
                }
                if a.title != b.title
                    || a.extended_title != b.extended_title
                    || items(&a) != items(&b)
                {
                    changes.push(change("observed-details-change"));
                }
            }
        }
    }
    Ok(Changes {
        observed_from: previous.captured_at.clone(),
        observed_through: current.captured_at.clone(),
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_age_reads_as_the_react_grid_wrote_it() {
        let row = |age: Option<f64>| -> Row {
            serde_json::from_value(serde_json::json!({
                "key": "k", "status": "equivalent", "reasons": [], "deliveredAsk": null,
                "listingAgeDays": age,
                "listing": { "title": null, "provider": "alt", "providerId": "1", "sourceUrl": null, "price": null,
                    "priceKind": "ask", "shipping": null }
            }))
            .unwrap()
        };
        assert_eq!(row(None).age(), "Unknown");
        assert_eq!(row(Some(0.4)).age(), "<1 day");
        assert_eq!(row(Some(3.9)).age(), "3 days");
        assert_eq!(money(None), "Unknown");
        assert_eq!(
            money(Some(&Money {
                amount: 5.0,
                currency: None
            })),
            "Unknown currency 5.00"
        );
    }
}
