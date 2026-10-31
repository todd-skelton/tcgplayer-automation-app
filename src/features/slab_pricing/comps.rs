//! Reviewing the saved comps of one evidence revision: each sale screened against the identity
//! researched, with the operator's decision on it, ported from `loadCompReview`. Saving decisions
//! stays the Node app's (`/api/slab-comp-decisions`); fetching a sale's details or an eBay
//! source's next page queues a provider call for its worker.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;

pub use super::screening::{Decision, Money, Sale};
use super::{
    research::{self, Window},
    screening::{self, Reference, SaleWindow, Target},
    url::Choice,
};
use crate::{database::Database, features::inventory_economics::ledger::assumptions::js_to_fixed};

/// Sales on a page of the review.
const PAGE: usize = 50;

/// A page of a revision's sales, screened, and what can be done with them.
#[derive(Clone, Debug)]
pub struct Review {
    pub revision_id: String,
    /// `alt-sales`, `ebay-sales` or `alt-sale-detail`.
    pub kind: String,
    /// The identity's revision the sales were screened against: a decision saved over a newer
    /// one is refused.
    pub identity_revision: i64,
    /// Decisions can be saved: the owned grade of a confirmed identity is researched.
    pub can_review: bool,
    pub coverage: Option<Coverage>,
    /// An eBay response of active listings instead of sold evidence.
    pub active_listings: bool,
    /// The eBay source has a next page to fetch.
    pub next_source_page: bool,
    pub page: Page,
    pub rows: Vec<Row>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub source_count: u32,
    pub reason: Option<String>,
    pub limit_per_grade: Option<u32>,
    /// The sale dates the source was asked for: what each sale's date is screened against.
    pub requested_window: Option<SaleWindow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub offset: u32,
    pub total: u32,
    pub next_offset: Option<u32>,
}

/// One sale, how it screened (`accepted`, `needs-review` or `rejected`) and why, and the
/// decision saved on it.
#[derive(Clone, Debug)]
pub struct Row {
    pub sale: Sale,
    pub status: String,
    pub reasons: Vec<String>,
    pub decision: Option<Decision>,
}

impl Sale {
    /// Its title, or its provider's id when it has none.
    pub fn name(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.provider_id)
    }

    /// `PSA 9` or `PSA MINT 9`: the grader and the label it printed, else its encoding.
    pub fn grade(&self) -> String {
        let shown = self
            .grading
            .label
            .as_deref()
            .unwrap_or(&self.grading.encoding);
        format!("{} {shown}", self.grading.grader)
    }

    /// A link to the sale, when it is an https address.
    pub fn link(&self) -> Option<&str> {
        self.source_url
            .as_deref()
            .filter(|u| u.starts_with("https://"))
    }
}

impl Review {
    /// The row at `index` in the whole revision, when it is on this page.
    pub fn row(&self, index: u32) -> Option<&Row> {
        let at = index.checked_sub(self.page.offset)?;
        self.rows.get(at as usize)
    }

    /// `51–100 of 120`, or how many when there is one page.
    pub fn range(&self) -> String {
        let shown = self.rows.len() as u32;
        let first = self.page.offset + u32::from(shown > 0);
        format!(
            "{first}–{} of {}",
            self.page.offset + shown,
            self.page.total
        )
    }

    /// What the revision covers, as the React review summed it up.
    pub fn summary(&self) -> String {
        let Some(c) = &self.coverage else {
            return "Saved sale detail".into();
        };
        let reason = c
            .reason
            .as_deref()
            .map(|r| format!(" · {}", super::identity::words(r)))
            .unwrap_or_default();
        let limit = c
            .limit_per_grade
            .map(|n| format!(" · Up to {n} sales per grade"))
            .unwrap_or_default();
        format!("{} source observations{reason}{limit}", c.source_count)
    }
}

/// `USD 12.30`, `Unknown currency 12.30`, or "Unknown", as the React review wrote a price.
pub fn money(value: Option<&Money>) -> String {
    value.map_or_else(
        || "Unknown".into(),
        |m| {
            let currency = m.currency.as_deref().unwrap_or("Unknown currency");
            format!("{currency} {}", js_to_fixed(m.amount, 2))
        },
    )
}

fn is_revision_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// A saved revision (`getEvidenceRevision`): its source key, what was fetched, and when.
struct Saved {
    id: String,
    payload: Value,
    fetched_at: DateTime<Utc>,
}

async fn saved(conn: &mut PgConnection, id: &str) -> Result<Option<Saved>, String> {
    if !is_revision_id(id) {
        return Err("Provide an evidence revision.".to_owned());
    }
    let failed = |e: sqlx::Error| e.to_string();
    type Record = (String, String, Value, DateTime<Utc>, Option<String>);
    let row: Option<Record> = sqlx::query_as(
        "SELECT id::text, key, payload, fetched_at, supply_scan_id::text FROM slab_evidence_revisions WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    let Some((id, key, payload, fetched_at, scan)) = row else {
        return Ok(None);
    };
    // Supply is read with its scan's listings; only that the scan is there matters here.
    if let Some(scan) = scan {
        let source: Option<String> =
            sqlx::query_scalar("SELECT source_key FROM slab_supply_scans WHERE id = $1::uuid")
                .bind(&scan)
                .fetch_optional(&mut *conn)
                .await
                .map_err(failed)?;
        let Some(source) = source else {
            return Ok(None);
        };
        if source != key {
            return Err("Supply revision scope changed.".to_owned());
        }
        if !matches!(payload["kind"].as_str(), Some("alt-supply" | "ebay-supply")) {
            return Err("Invalid supply revision.".to_owned());
        }
    }
    Ok(Some(Saved {
        id,
        payload,
        fetched_at,
    }))
}

/// `getCompDecisions` of one revision: what the operator decided on its sales for the group.
async fn decisions(
    conn: &mut PgConnection,
    group: &str,
    revision: &str,
) -> Result<Vec<Decision>, String> {
    let hex = group.len() == 64
        && group
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex {
        return Err("Choose a valuation group and at most fifty evidence revisions.".to_owned());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT decision FROM slab_comp_decisions WHERE valuation_group_key = $1 AND revision_id = $2::uuid ORDER BY revision_id, event_key LIMIT 2001",
    )
    .bind(group)
    .bind(revision)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if rows.len() > 2000 {
        return Err("Narrow the evidence selection before loading reviews.".to_owned());
    }
    rows.into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(|e| format!("A comp decision could not be read: {e}"))
}

/// `loadCompReview`: the page of `revision` from `offset`, screened against the slab `id` at
/// `grade`. It never calls a provider.
async fn review(
    conn: &mut PgConnection,
    id: &str,
    grade: &str,
    window: &Window,
    revision: &str,
    offset: u32,
) -> Result<Review, String> {
    if offset > 2000 {
        return Err("Invalid evidence page.".to_owned());
    }
    let plan = research::plan(conn, id, grade, window).await?;
    let saved = saved(conn, revision)
        .await?
        .ok_or_else(|| "Evidence revision is no longer available.".to_owned())?;
    let kind = saved.payload["kind"].as_str().unwrap_or("").to_owned();
    let data = &saved.payload["data"];
    let sales: &[Value] = match kind.as_str() {
        "alt-sale-detail" if !data.is_null() => std::slice::from_ref(data),
        "alt-sales" | "ebay-sales" => data["sales"].as_array().map_or(&[], Vec::as_slice),
        _ => &[],
    };
    let coverage: Option<Coverage> = match kind.as_str() {
        "alt-sales" | "ebay-sales" if !data["coverage"].is_null() => Some(
            serde_json::from_value(data["coverage"].clone())
                .map_err(|e| format!("The revision's coverage could not be read: {e}"))?,
        ),
        _ => None,
    };
    let group = plan
        .valuation_group_key
        .as_deref()
        .filter(|k| !k.is_empty());
    let can_review = grade == "owned" && plan.status == "confirmed" && group.is_some();
    let decisions = match group {
        Some(group) if can_review => decisions(conn, group, &saved.id).await?,
        _ => Vec::new(),
    };
    let target = Target {
        confirmed: plan.status == "confirmed",
        identity: Some(&plan.target),
        valuation_group_key: group,
    };
    let fetched_at = saved
        .fetched_at
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let start = (offset as usize).min(sales.len());
    let page = &sales[start..(start + PAGE).min(sales.len())];
    let rows = page
        .iter()
        .map(|value| {
            let sale: Sale = serde_json::from_value(value.clone())
                .map_err(|e| format!("A saved sale could not be read: {e}"))?;
            let decision = decisions
                .iter()
                .find(|d| {
                    d.provider == sale.provider
                        && d.provider_id == sale.provider_id
                        && d.date == sale.date
                })
                .cloned();
            let day = sale.date.clone().unwrap_or_default();
            let window = coverage
                .as_ref()
                .and_then(|c| c.requested_window.clone())
                .unwrap_or(SaleWindow {
                    from: day.clone(),
                    to: day,
                });
            let reference = Reference {
                revision_id: &saved.id,
                fetched_at: &fetched_at,
                window,
                sale: &sale,
            };
            let screened = screening::screen(&reference, &target, "USD", decision.as_ref());
            Ok(Row {
                status: screened.status.to_owned(),
                reasons: screened.reasons.into_iter().map(|r| r.code).collect(),
                sale,
                decision,
            })
        })
        .collect::<Result<_, String>>()?;
    let total = sales.len() as u32;
    let next = offset + PAGE as u32;
    Ok(Review {
        revision_id: saved.id.clone(),
        identity_revision: plan.revision,
        can_review,
        coverage,
        active_listings: kind == "ebay-sales" && data["status"].as_str() != Some("sold"),
        next_source_page: kind == "ebay-sales" && !data["page"]["nextOffset"].is_null(),
        page: Page {
            offset,
            total,
            next_offset: (next < total).then_some(next),
        },
        rows,
        kind,
    })
}

/// The page of `revision` the choice shows, screened against the slab `id` at its grade.
pub async fn read(
    db: &Database,
    id: &str,
    revision: &str,
    choice: &Choice,
) -> Result<Review, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    let offset = choice.comps_from.unwrap_or(0);
    review(
        &mut conn,
        id,
        choice.grade(),
        &choice.window(),
        revision,
        offset,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_of(offset: u32, rows: usize, total: u32) -> Review {
        let sale: Sale = serde_json::from_value(serde_json::json!({
            "provider": "alt", "providerId": "p", "sourceUrl": "http://x", "kind": "transaction",
            "grading": { "grader": "PSA", "encoding": "9", "number": 9 }
        }))
        .unwrap();
        let row = Row {
            sale,
            status: "accepted".into(),
            reasons: Vec::new(),
            decision: None,
        };
        Review {
            revision_id: "r".into(),
            kind: "alt-sales".into(),
            identity_revision: 1,
            can_review: true,
            coverage: Some(Coverage {
                source_count: 4,
                reason: Some("capped-per-grade".into()),
                limit_per_grade: Some(16),
                requested_window: None,
            }),
            active_listings: false,
            next_source_page: false,
            page: Page {
                offset,
                total,
                next_offset: None,
            },
            rows: vec![row; rows],
        }
    }

    /// The cases in `.port-logs/comp-review-cases.json` on the slabs, revisions and decisions
    /// `comp-review-seed.sql` saves, in a transaction rolled back, against Node's `loadCompReview`
    /// (`.port-logs/comp-review-node.ts`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn reviews_read_as_node_reads_them() {
        #[derive(Deserialize)]
        struct Case {
            id: String,
            grade: String,
            from: String,
            to: String,
            revision: String,
            offset: u32,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Case> = serde_json::from_str(&read("comp-review-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("comp-review.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('slab_evidence_refreshes tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(&read("comp-review-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let window = Window {
                from: case.from.clone(),
                to: case.to.clone(),
            };
            let shown = format!(
                "{} at {} of {} from {}",
                case.id, case.grade, case.revision, case.offset
            );
            let ours = review(
                &mut tx,
                &case.id,
                &case.grade,
                &window,
                &case.revision,
                case.offset,
            )
            .await;
            let ours = match ours {
                Err(error) => {
                    assert_eq!(Some(error.as_str()), theirs["error"].as_str(), "{shown}");
                    continue;
                }
                Ok(ours) => ours,
            };
            assert!(
                theirs["error"].is_null(),
                "{shown}: Node refused with {}",
                theirs["error"]
            );
            assert_eq!(ours.revision_id, theirs["revisionId"], "{shown}");
            assert_eq!(ours.kind, theirs["kind"], "{shown}");
            assert_eq!(
                ours.identity_revision, theirs["identityRevision"],
                "{shown}"
            );
            assert_eq!(ours.can_review, theirs["canReview"], "{shown}");
            assert_eq!(ours.active_listings, theirs["activeListings"], "{shown}");
            assert_eq!(ours.next_source_page, theirs["nextSourcePage"], "{shown}");
            let page = &theirs["page"];
            assert_eq!(
                (ours.page.offset, ours.page.total, ours.page.next_offset),
                (
                    page["offset"].as_u64().unwrap() as u32,
                    page["total"].as_u64().unwrap() as u32,
                    page["nextOffset"].as_u64().map(|n| n as u32)
                ),
                "{shown}"
            );
            let coverage = ours
                .coverage
                .as_ref()
                .map(|c| (c.source_count, c.reason.clone(), c.limit_per_grade));
            let their_coverage: Option<Coverage> =
                serde_json::from_value(theirs["coverage"].clone()).unwrap();
            assert_eq!(
                coverage,
                their_coverage.map(|c| (c.source_count, c.reason, c.limit_per_grade)),
                "{shown}"
            );
            let rows = theirs["rows"].as_array().unwrap();
            assert_eq!(ours.rows.len(), rows.len(), "{shown}");
            for (row, their) in ours.rows.iter().zip(rows) {
                let at = format!("{shown}, sale {}", row.sale.provider_id);
                assert_eq!(row.sale.provider_id, their["sale"]["providerId"], "{at}");
                assert_eq!(
                    row.status, their["status"],
                    "{at}: {:?} {}",
                    row.reasons, their["reasons"]
                );
                let reasons: Vec<String> =
                    serde_json::from_value(their["reasons"].clone()).unwrap();
                assert_eq!(row.reasons, reasons, "{at}");
                let decision: Option<Decision> =
                    serde_json::from_value(their["decision"].clone()).unwrap();
                assert_eq!(row.decision, decision, "{at}");
            }
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn a_row_is_found_by_its_place_in_the_revision() {
        let page = page_of(50, 2, 52);
        assert!(page.row(49).is_none());
        assert!(page.row(50).is_some());
        assert!(page.row(51).is_some());
        assert!(page.row(52).is_none());
        assert_eq!(page.range(), "51–52 of 52");
        assert_eq!(page_of(0, 0, 0).range(), "0–0 of 0");
    }

    #[test]
    fn a_sale_reads_as_the_react_review_wrote_it() {
        let page = page_of(0, 1, 1);
        let sale = &page.rows[0].sale;
        assert_eq!(sale.name(), "p");
        assert_eq!(sale.grade(), "PSA 9");
        assert_eq!(sale.link(), None, "only https links");
        assert_eq!(
            page.summary(),
            "4 source observations · capped per grade · Up to 16 sales per grade"
        );
        assert_eq!(money(None), "Unknown");
        let unpriced = Money {
            amount: 102.125,
            currency: None,
        };
        assert_eq!(money(Some(&unpriced)), "Unknown currency 102.13");
    }
}
