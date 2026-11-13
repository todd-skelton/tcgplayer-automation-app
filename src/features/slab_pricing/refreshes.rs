//! Queuing evidence refreshes for Node's slab evidence worker, which calls eBay and Alt: the
//! research for a grade and dates, its active supply, an eBay source's next page and an Alt
//! sale's details. Ported from the actions of `api.slab-evidence.server.ts` and
//! `api.slab-supply.server.ts` (`requestSlabSupply`). Nothing is fetched here; Node woke its
//! in-process worker after queuing, which this process cannot, so the worker must be running on
//! its own and finds the queue on its poll.
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, pool::PoolConnection};

use super::{comps, research};
use crate::{
    database::Database,
    features::slab_evidence::{
        spec::{EbayPage, Spec},
        store::{self, Status},
    },
};

/// What Node answered when the database failed, a 500 where every refusal is a 400.
pub(super) const UNABLE: &str = "Unable to access slab evidence.";

/// The database failing, logged and answered as Node answered it.
pub(super) fn unable(error: impl std::fmt::Display) -> String {
    tracing::error!("slab evidence: {error}");
    UNABLE.to_owned()
}

/// A connection to queue on.
pub async fn connection(db: &Database) -> Result<PoolConnection<Postgres>, String> {
    db.0.acquire().await.map_err(unable)
}

/// The priority a person's refresh is queued at, ahead of maintenance's.
const ASKED: i32 = 200;

/// The priority a page or a sale's details is queued at (`requestEvidence`'s default).
const ADDED: i32 = 100;

/// The identity revision the page showed, which a refresh must still be at.
fn current(revision: i64) -> Result<Option<i64>, String> {
    if revision < 1 {
        return Err("Provide the current identity revision.".to_owned());
    }
    Ok(Some(revision))
}

async fn queue(
    conn: &mut PgConnection,
    specs: &[Spec],
    force: bool,
    priority: i32,
) -> Result<Vec<Status>, String> {
    store::request(conn, specs, force, priority)
        .await
        .map_err(refused_or_unable)
}

pub(super) fn refused_or_unable(error: store::Error) -> String {
    match error {
        store::Error::Refused(why) => why.0,
        store::Error::Database(error) => unable(error),
    }
}

/// The research's sales for the slab at `grade` over `window` (`intent: research`), fetched again
/// even when fresh when `force`d.
pub async fn research(
    conn: &mut PgConnection,
    id: &str,
    revision: i64,
    grade: &str,
    window: &research::Window,
    force: bool,
) -> Result<Vec<Status>, String> {
    let plan = research::plan(conn, id, current(revision)?, grade, window).await?;
    let specs = research::requests(&plan.target, window, false)?;
    queue(conn, &specs, force, ASKED).await
}

/// The slab's active supply at `grade` (`requestSlabSupply`), fetched again even when fresh.
pub async fn supply(
    conn: &mut PgConnection,
    id: &str,
    revision: i64,
    grade: &str,
    window: &research::Window,
) -> Result<Vec<Status>, String> {
    let plan = research::plan(conn, id, current(revision)?, grade, window).await?;
    let specs = research::requests(&plan.target, window, true)?;
    queue(conn, &specs, true, ASKED).await
}

/// The page after the one an eBay revision saved (`intent: next-page`).
pub async fn next_page(conn: &mut PgConnection, revision: &str) -> Result<Vec<Status>, String> {
    let saved = comps::saved(conn, revision)
        .await?
        .filter(|s| {
            matches!(
                s.payload["kind"].as_str(),
                Some("ebay-sales" | "ebay-supply")
            )
        })
        .ok_or_else(|| "Choose an eBay evidence revision.".to_owned())?;
    let status = store::statuses(&mut *conn, std::slice::from_ref(&saved.key))
        .await
        .map_err(refused_or_unable)?
        .into_iter()
        .next();
    let next = saved.payload["data"]
        .get("page")
        .filter(|page| page.is_object())
        .and_then(|page| page.get("nextOffset"))
        .filter(|next| !next.is_null());
    let next_page = |page: &EbayPage, next: &Value| EbayPage {
        offset: next.as_i64().unwrap_or(-1),
        ..page.clone()
    };
    let spec = match (status.map(|s| s.spec), next) {
        (Some(Spec::EbaySales(page)), Some(next)) => Spec::EbaySales(next_page(&page, next)),
        (Some(Spec::EbaySupply(page)), Some(next)) => Spec::EbaySupply(next_page(&page, next)),
        _ => return Err("This evidence has no next page.".to_owned()),
    };
    queue(conn, &[spec], false, ADDED).await
}

/// What `refresh` queued for a selection of slabs (`requestSlabEvidence`).
pub struct Refreshed {
    /// Each slab's evidence keys, or why it has none (`{ slabId, revision, keys, reason }`).
    pub slabs: Vec<Value>,
    pub statuses: Vec<Status>,
    /// The slabs read, and the requests they need, once each.
    pub records: usize,
    pub requests: usize,
}

/// The sales (and with `supply` the unsold listings) of each confirmed slab in `ids` over
/// `window`, queued at once, fetched again even when fresh when `force`d (`intent: refresh`).
pub async fn slabs(
    conn: &mut PgConnection,
    ids: &Value,
    window: &research::Window,
    supply: bool,
    force: bool,
) -> Result<Refreshed, String> {
    let id_like = |id: &&str| {
        id.len() == 36
            && id
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    };
    let ids: Option<Vec<&str>> = ids
        .as_array()
        .filter(|ids| ids.len() <= 50)
        .and_then(|ids| ids.iter().map(|id| id.as_str().filter(id_like)).collect());
    let Some(ids) = ids else {
        return Err("Select at most fifty slab identities.".to_owned());
    };
    let mut unique: Vec<&str> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    type Record = (String, Option<Value>, String, i32, Option<String>);
    let mut records: Vec<Record> = sqlx::query_as(
        "SELECT id::text, identity, status, revision, valuation_group_key FROM slab_identities WHERE id = ANY($1::uuid[])",
    )
    .bind(&unique)
    .fetch_all(&mut *conn)
    .await
    .map_err(unable)?;
    if records.len() != unique.len() {
        return Err("One or more slab identities no longer exist.".to_owned());
    }
    // In the order asked. Node's were in whatever order the database answered.
    records.sort_by_key(|(id, ..)| unique.iter().position(|asked| asked == id));
    research::to_spec_window(window)
        .checked()
        .map_err(|e| e.0)?;
    let mut requests: Vec<(String, Spec)> = Vec::new();
    let mut slabs = Vec::new();
    for (id, identity, status, revision, group) in &records {
        let confirmed = (status == "confirmed")
            .then_some(())
            .and(identity.as_ref().filter(|i| !i.is_null()))
            .zip(group.as_deref());
        let Some((identity, group)) = confirmed else {
            slabs.push(json!({
                "slabId": id, "revision": revision, "keys": [],
                "reason": "Confirm the slab identity first.",
            }));
            continue;
        };
        let identity: research::Identity =
            serde_json::from_value(identity.clone()).map_err(unable)?;
        let planned = research::planned(&identity, group, window, supply)?;
        let keys: Vec<&String> = planned.iter().map(|(key, _)| key).collect();
        slabs.push(json!({ "slabId": id, "revision": revision, "keys": keys, "reason": null }));
        for (key, spec) in planned {
            match requests.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = spec,
                None => requests.push((key, spec)),
            }
        }
    }
    let specs: Vec<Spec> = requests.into_iter().map(|(_, spec)| spec).collect();
    let statuses = queue(conn, &specs, force, ASKED).await?;
    Ok(Refreshed {
        slabs,
        statuses,
        records: records.len(),
        requests: specs.len(),
    })
}

/// An Alt sale's full details (`intent: sale-detail`), for a sale the revision shown holds.
pub async fn sale_detail(
    conn: &mut PgConnection,
    revision: &str,
    transaction: &str,
) -> Result<Vec<Status>, String> {
    let saved = comps::saved(conn, revision).await?;
    let held = saved.is_some_and(|s| {
        s.payload["kind"] == "alt-sales"
            && s.payload["data"]["sales"]
                .as_array()
                .is_some_and(|sales| sales.iter().any(|sale| sale["providerId"] == transaction))
    });
    if !held {
        return Err("Choose a sale from the displayed Alt evidence revision.".to_owned());
    }
    let spec = Spec::AltSaleDetail {
        transaction_id: transaction.to_owned(),
    };
    queue(conn, &[spec], false, ADDED).await
}
