//! Research for the certificate shown: the evidence saved for a grade (the owned one, or a PSA
//! grade explored beside it) over a window of sale dates, and whether a refresh is on its way,
//! ported from `loadSlabWorkspace`, and where refreshes on their way stand. Refreshing stays the
//! slab evidence worker's, which calls eBay and Alt; a status read wakes no worker, so the worker
//! must be running on its own.
use std::collections::BTreeSet;

use chrono::{Days, NaiveDate, SecondsFormat, Utc};
use chrono_tz::America::Chicago;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::recommendation::{self, Recommendation};
use crate::{
    database::Database,
    features::{
        inventory_economics::ledger::fingerprint::{js_float, js_json, sha256_hex},
        slab_evidence::{
            spec::{self, EbayPage, Spec as Request},
            store,
        },
    },
};

/// The PSA grades a slab can be explored at beside its own: every half grade from 1 to 10 but
/// 9.5, which PSA does not give.
pub const PSA_GRADES: [&str; 18] = [
    "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5",
    "9", "10",
];

/// The sale dates evidence is read over, as `YYYY-MM-DD`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Window {
    pub from: String,
    pub to: String,
}

impl Window {
    /// The year up to today in Chicago, where the seller works.
    pub fn last_year() -> Window {
        Window::year_to(Utc::now().with_timezone(&Chicago).date_naive())
    }

    pub(super) fn year_to(today: NaiveDate) -> Window {
        let from = today.checked_sub_days(Days::new(365)).unwrap_or(today);
        Window {
            from: from.format("%Y-%m-%d").to_string(),
            to: today.format("%Y-%m-%d").to_string(),
        }
    }
}

/// What is saved for a slab's research at one grade and window.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub statuses: Vec<EvidenceStatus>,
    pub keys: Vec<String>,
    /// Why no cross-grade estimate is offered.
    pub grade_model: Option<GradeModel>,
    /// The slab's latest recommendation, whatever grade is researched.
    pub recommendation: Option<Recommendation>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GradeModel {
    pub reason: String,
}

/// One piece of evidence (eBay sales, Alt sales, supply) and where its refresh stands.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceStatus {
    pub key: String,
    pub spec: Spec,
    /// `queued`, `running`, `idle`, `failed` or `cancelled`.
    pub state: String,
    pub run_id: String,
    /// The saved revision the comps are read from, once one was fetched.
    pub latest_revision: Option<String>,
    pub fetched_at: Option<String>,
    pub error_code: Option<String>,
    /// Expired, never fetched, or failed.
    pub stale: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Spec {
    pub kind: String,
    /// An eBay page's first result and page size.
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

impl EvidenceStatus {
    /// A refresh is queued or running, so the panel reads it again.
    pub fn pending(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "running")
    }
}

impl Workspace {
    pub fn pending(&self) -> bool {
        self.statuses.iter().any(EvidenceStatus::pending)
    }

    /// The evidence revisions saved for the grade and dates: what a calculation reads.
    pub fn latest_revisions(&self) -> BTreeSet<String> {
        self.statuses
            .iter()
            .filter_map(|s| s.latest_revision.clone())
            .collect()
    }
}

/// A slab's card and grade, as saved (`SlabIdentity`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity {
    pub(super) card: Card,
    pub(super) grading: Grading,
    #[serde(default)]
    provider_asset: Option<Asset>,
}

/// `CARD_FIELDS`, in their order.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Card {
    pub(super) name: Option<String>,
    pub(super) game: Option<String>,
    pub(super) language: Option<String>,
    pub(super) set: Option<String>,
    pub(super) card_number: Option<String>,
    pub(super) year: Option<String>,
    pub(super) edition: Option<String>,
    pub(super) finish: Option<String>,
    pub(super) stamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct Grading {
    pub(super) grader: String,
    pub(super) encoding: String,
    pub(super) number: Option<f64>,
    pub(super) label: Option<String>,
    pub(super) qualifier: Option<String>,
    pub(super) autograph: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Asset {
    provider: String,
    id: String,
}

/// JavaScript's `trim`, which also takes the byte order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

impl Identity {
    /// `valuationGroupKey`: what makes two slabs the same for valuation, hashed. No certificate
    /// or listing is part of it.
    fn group_key(&self) -> String {
        let normalized =
            |value: &Option<String>| json!(value.as_deref().map(|v| js_trim(v).to_lowercase()));
        let c = &self.card;
        let g = &self.grading;
        let fields = [
            normalized(&c.name),
            normalized(&c.game),
            normalized(&c.language),
            normalized(&c.set),
            normalized(&c.card_number),
            normalized(&c.year),
            normalized(&c.edition),
            normalized(&c.finish),
            normalized(&c.stamp),
            json!(self.provider_asset.as_ref().map(|a| &a.provider)),
            json!(self.provider_asset.as_ref().map(|a| &a.id)),
            json!(g.grader),
            g.number.map_or_else(|| json!(g.encoding), |n| json!(n)),
            normalized(&g.label),
            normalized(&g.qualifier),
            normalized(&g.autograph),
        ];
        sha256_hex(&js_json(&fields))
    }

    /// The Alt asset the card was matched to, if any.
    pub(super) fn provider_asset_id(&self) -> Option<&str> {
        self.provider_asset.as_ref().map(|a| a.id.as_str())
    }

    /// `buildResearchKeywords`: the card and grade as an eBay search, PSA's grade without its
    /// label.
    fn keywords(&self) -> String {
        let c = &self.card;
        let g = &self.grading;
        let number = g.number.map_or_else(|| g.encoding.clone(), js_float);
        let label = g.label.as_ref().filter(|_| g.grader != "PSA");
        [
            c.year.as_ref(),
            c.game.as_ref(),
            c.name.as_ref(),
            c.card_number.as_ref(),
            c.set.as_ref(),
            c.language.as_ref(),
            c.edition.as_ref(),
            c.finish.as_ref(),
            c.stamp.as_ref(),
            Some(&g.grader),
            Some(&number),
            label,
            g.qualifier.as_ref(),
            g.autograph.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
    }

    /// `researchTarget`: the identity at `grade`, the owned one or a PSA grade explored beside it.
    fn at_grade(self, grade: &str) -> Result<Identity, String> {
        if grade == "owned" {
            return Ok(self);
        }
        let half = |g: &str| match g.split_once('.') {
            Some((whole, "5")) => whole.len() == 1 && matches!(whole.as_bytes()[0], b'1'..=b'9'),
            None => (g.len() == 1 && matches!(g.as_bytes()[0], b'1'..=b'9')) || g == "10",
            _ => false,
        };
        if self.grading.grader != "PSA" || !half(grade) || grade == "9.5" {
            return Err("Choose the owned grade or a supported PSA research grade.".to_owned());
        }
        let number: f64 = grade
            .parse()
            .map_err(|_| "Choose a PSA grade.".to_owned())?;
        Ok(Identity {
            grading: Grading {
                grader: "PSA".to_owned(),
                encoding: grade.to_owned(),
                number: Some(number),
                label: Some(format!("PSA {grade}")),
                qualifier: None,
                autograph: None,
            },
            ..self
        })
    }

    /// `gradeModelStatus`: why no cross-grade estimate is offered.
    fn grade_model(identity: Option<&Identity>) -> GradeModel {
        let psa_one =
            identity.is_some_and(|i| i.grading.grader == "PSA" && i.grading.number == Some(1.0));
        GradeModel {
            reason: if psa_one {
                "PSA 1 collector pricing is not inferred from higher grades. Review its direct sales."
            } else {
                "No cross-grade model has enough verified, time-separated evidence for this cohort. Pricing uses direct sales and your review."
            }
            .to_owned(),
        }
    }

    /// `planSlabEvidence` for one confirmed slab: the keys of [`specs`].
    fn keys(&self, window: &Window) -> Result<Vec<String>, String> {
        specs_checked(self, window)?
            .iter()
            .map(|r| r.key().map_err(|e| e.0))
            .collect()
    }
}

/// `planSlabEvidence` with supply, which it keeps: the keys of the slab's unsold listings, Alt's
/// when Alt knows the card and eBay's for the same search as its sales.
pub(super) fn supply_keys(identity: &Identity, window: &Window) -> Result<Vec<String>, String> {
    requests(identity, window, true)?
        .iter()
        .map(|r| r.key().map_err(|e| e.0))
        .collect()
}

/// `planSlabEvidence`'s requests for one confirmed slab: its sales, or with `supply` its unsold
/// listings (Alt's when Alt knows the card, and eBay's for the same search).
pub(super) fn requests(
    identity: &Identity,
    window: &Window,
    supply: bool,
) -> Result<Vec<Request>, String> {
    let sales = specs_checked(identity, window)?;
    if !supply {
        return Ok(sales);
    }
    Ok(sales
        .into_iter()
        .filter_map(|request| match request {
            Request::AltSales { asset_id, .. } => Some(Request::AltSupply { asset_id }),
            Request::EbaySales(page) => Some(Request::EbaySupply(page)),
            _ => None,
        })
        .collect())
}

/// `planSlabEvidence` for one confirmed slab in its saved valuation group `group`: its Alt sales
/// (and with `supply` Alt's unsold listings) when Alt knows the card, then its eBay sales (and
/// unsold listings), each normalized, by key, once each.
pub(super) fn planned(
    identity: &Identity,
    group: &str,
    window: &Window,
    supply: bool,
) -> Result<Vec<(String, Request)>, String> {
    let window = spec::Window {
        from: window.from.clone(),
        to: window.to.clone(),
    }
    .checked()
    .map_err(|e| e.0)?;
    let mut requests = Vec::new();
    if let Some(asset) = &identity.provider_asset {
        requests.push(Request::AltSales {
            asset_id: asset.id.clone(),
            window: window.clone(),
            limit_per_grade: 16,
        });
        if supply {
            requests.push(Request::AltSupply {
                asset_id: asset.id.clone(),
            });
        }
    }
    let page = EbayPage {
        group_key: group.to_owned(),
        keywords: identity.keywords(),
        window,
        offset: 0,
        limit: 50,
        timezone: "America/Chicago".to_owned(),
    };
    requests.push(Request::EbaySales(page.clone()));
    if supply {
        requests.push(Request::EbaySupply(page));
    }
    let mut keyed: Vec<(String, Request)> = Vec::new();
    for request in requests {
        let request = request.normalized().map_err(|e| e.0)?;
        let key = request.key().map_err(|e| e.0)?;
        match keyed.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = request,
            None => keyed.push((key, request)),
        }
    }
    Ok(keyed)
}

/// The window as an evidence request writes it.
pub(super) fn to_spec_window(window: &Window) -> spec::Window {
    spec::Window {
        from: window.from.clone(),
        to: window.to.clone(),
    }
}

/// What to read for a slab: its Alt sales when Alt knows the card, and its eBay sales.
fn specs_checked(identity: &Identity, window: &Window) -> Result<Vec<Request>, String> {
    let window = spec::Window {
        from: window.from.clone(),
        to: window.to.clone(),
    }
    .checked()
    .map_err(|e| e.0)?;
    let mut requests = Vec::new();
    if let Some(asset) = &identity.provider_asset {
        requests.push(Request::AltSales {
            asset_id: asset.id.clone(),
            window: window.clone(),
            limit_per_grade: 16,
        });
    }
    requests.push(Request::EbaySales(EbayPage {
        group_key: identity.group_key(),
        keywords: identity.keywords(),
        window,
        offset: 0,
        limit: 50,
        timezone: "America/Chicago".to_owned(),
    }));
    Ok(requests)
}

pub(super) fn status(s: store::Status) -> EvidenceStatus {
    let (offset, limit) = match &s.spec {
        Request::EbaySales(page) | Request::EbaySupply(page) => (
            u32::try_from(page.offset).ok(),
            u32::try_from(page.limit).ok(),
        ),
        _ => (None, None),
    };
    EvidenceStatus {
        spec: Spec {
            kind: s.spec.kind().to_owned(),
            offset,
            limit,
        },
        key: s.key,
        state: s.state,
        run_id: s.run_id,
        latest_revision: s.latest_revision,
        fetched_at: s
            .fetched_at
            .map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true)),
        error_code: s.error_code,
        stale: s.stale,
    }
}

/// The research as read, its recommendation as saved.
#[derive(Debug, PartialEq)]
struct Researched {
    keys: Vec<String>,
    statuses: Vec<EvidenceStatus>,
    grade_model: GradeModel,
    recommendation: Option<Value>,
}

/// A slab as `loadResearchPlan` reads it: its identity at the grade researched, the evidence
/// keys for it over the window, and the slab's own state.
pub(super) struct Plan {
    /// `confirmed` or `needs-review`.
    pub(super) status: String,
    /// The identity's revision: a decision saved over a newer one is refused.
    pub(super) revision: i64,
    pub(super) target: Identity,
    /// The target's valuation group: the slab's saved one at the owned grade, else the grade's.
    pub(super) valuation_group_key: Option<String>,
    keys: Vec<String>,
    grade_model: GradeModel,
}

/// `loadResearchPlan` with `researchTarget`: the slab `id` at `grade` (`owned` or a PSA grade),
/// and the evidence keys for it over `window`.
pub(super) async fn plan(
    conn: &mut PgConnection,
    id: &str,
    revision: Option<i64>,
    grade: &str,
    window: &Window,
) -> Result<Plan, String> {
    let uuid = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        });
    if !uuid {
        return Err("Choose a saved slab identity.".to_owned());
    }
    type Record = (Option<Value>, Option<Value>, String, i32, Option<String>);
    let record: Option<Record> = sqlx::query_as(
        "SELECT identity, candidate->'identity', status, revision, valuation_group_key FROM slab_identities WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(super::refreshes::unable)?;
    let Some((saved, candidate, status, revision, saved_key)) = record
        .filter(|(.., saved_revision, _)| revision.is_none_or(|r| r == i64::from(*saved_revision)))
    else {
        return Err("The slab identity changed. Reopen it before refreshing.".to_owned());
    };
    let identity = |value: Option<Value>| {
        value
            .filter(|v| !v.is_null())
            .map(serde_json::from_value::<Identity>)
            .transpose()
            .map_err(super::refreshes::unable)
    };
    let source = match identity(saved)? {
        Some(owned) => Some(owned),
        None => identity(candidate)?,
    };
    let grade_model = Identity::grade_model(source.as_ref());
    let Some(source) = source else {
        return Err("Correct the card identity before researching it.".to_owned());
    };
    let target = source.at_grade(grade)?;
    let keys = target.keys(window)?;
    let valuation_group_key = if grade == "owned" {
        saved_key
    } else {
        Some(target.group_key())
    };
    Ok(Plan {
        status,
        revision: i64::from(revision),
        target,
        valuation_group_key,
        keys,
        grade_model,
    })
}

/// `loadSlabWorkspace`: the slab's evidence keys at `grade` over `window`, where their
/// refreshes stand, and its latest recommendation.
async fn research(
    conn: &mut PgConnection,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Researched, String> {
    let Plan {
        keys, grade_model, ..
    } = plan(conn, id, None, grade, window).await?;
    let statuses = store::statuses(&mut *conn, &keys)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(status)
        .collect();
    let recommendation: Option<Value> = sqlx::query_scalar(recommendation::LATEST)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Researched {
        keys,
        statuses,
        grade_model,
        recommendation,
    })
}

/// The slab's research at `grade` (`owned` or a PSA grade) over `window`.
pub async fn read(
    db: &Database,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Workspace, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    let researched = research(&mut conn, id, grade, window).await?;
    Ok(Workspace {
        statuses: researched.statuses,
        keys: researched.keys,
        grade_model: Some(researched.grade_model),
        recommendation: researched
            .recommendation
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| format!("The slab's recommendation could not be read: {e}"))?,
    })
}

/// Where the refreshes of `keys` stand (`evidenceStatuses`), as the evidence list's poll reads them.
pub async fn statuses(db: &Database, keys: &[String]) -> Result<Vec<EvidenceStatus>, String> {
    store::statuses(&db.0, keys)
        .await
        .map(|rows| rows.into_iter().map(status).collect())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_window_is_the_year_to_today() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(
            Window::year_to(today),
            Window {
                from: "2025-10-30".into(),
                to: "2026-10-30".into()
            }
        );
    }

    #[test]
    fn a_queued_or_running_refresh_is_pending() {
        let status = |state: &str| -> EvidenceStatus {
            serde_json::from_value(serde_json::json!({
                "key": "k", "spec": { "kind": "ebay-sales" }, "state": state, "runId": "r",
                "latestRevision": null, "fetchedAt": null, "errorCode": null, "stale": true
            }))
            .unwrap()
        };
        assert!(status("queued").pending());
        assert!(status("running").pending());
        assert!(!status("failed").pending());
    }
}
