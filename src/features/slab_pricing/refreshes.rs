//! Queuing evidence refreshes for Node's slab evidence worker, which calls eBay and Alt: the
//! research for a grade and dates, its active supply, an eBay source's next page and an Alt
//! sale's details. Ported from the actions of `api.slab-evidence.server.ts` and
//! `api.slab-supply.server.ts` (`requestSlabSupply`). Nothing is fetched here; Node woke its
//! in-process worker after queuing, which this process cannot, so the worker must be running on
//! its own and finds the queue on its poll.
use serde_json::Value;
use sqlx::{PgConnection, Postgres, pool::PoolConnection};

use super::{comps, research};
use crate::{
    database::Database,
    features::slab_evidence::{
        spec::{EbayPage, Spec},
        store::{self, Status},
    },
};

/// A connection to queue on.
pub async fn connection(db: &Database) -> Result<PoolConnection<Postgres>, String> {
    db.0.acquire().await.map_err(|error| {
        eprintln!("slab evidence: {error}");
        "Unable to access slab evidence.".to_owned()
    })
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
        .map_err(|error| match error {
            store::Error::Refused(why) => why.0,
            store::Error::Database(error) => {
                eprintln!("slab evidence: {error}");
                "Unable to access slab evidence.".to_owned()
            }
        })
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
        .map_err(|e| e.to_string())?
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::Connection;

    use super::*;

    /// Node's `/api/slab-evidence` and `/api/slab-supply` actions recorded over
    /// `.port-logs/slab-refresh-cases.json` (`slab-refresh-node.ts`) on the slabs and evidence
    /// `slab-workspace-seed.sql`, `slab-inventory-seed.sql`, `slab-supply-seed.sql` and
    /// `slab-refresh-seed.sql` save: each case queued here as it stood, inside a transaction rolled
    /// back, must answer as Node answered (its refusals were 400s with the message here) and leave
    /// the queue as Node left it.
    #[tokio::test]
    #[ignore = "reads the dev database and .port-logs; writes only in a transaction that is rolled back"]
    async fn queues_as_node_queues() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read("slab-refresh-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("slab-refresh.node.json")).unwrap();
        let capture = read("slab-refresh-capture.sql");
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        for seed in [
            "slab-workspace-seed.sql",
            "slab-inventory-seed.sql",
            "slab-supply-seed.sql",
            "slab-refresh-seed.sql",
        ] {
            sqlx::raw_sql(&read(seed)).execute(&mut *tx).await.unwrap();
        }
        for (case, node) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let body = &case["body"];
            let text = |key: &str| body[key].as_str().unwrap_or_default().to_owned();
            let window = research::Window {
                from: body["window"]["from"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                to: body["window"]["to"].as_str().unwrap_or_default().to_owned(),
            };
            let revision = body["identityRevision"].as_i64().unwrap_or_default();
            let mut each = tx.begin().await.unwrap();
            let mut answers = Vec::new();
            for _ in 0..node["answers"].as_array().unwrap().len() {
                let queued = match case["kind"].as_str().unwrap() {
                    "research" => {
                        research(
                            &mut each,
                            &text("slabId"),
                            revision,
                            &text("grade"),
                            &window,
                            body["force"] == true,
                        )
                        .await
                    }
                    "supply" => {
                        supply(
                            &mut each,
                            &text("slabId"),
                            revision,
                            &text("grade"),
                            &window,
                        )
                        .await
                    }
                    "next-page" => next_page(&mut each, &text("revision")).await,
                    _ => sale_detail(&mut each, &text("revision"), &text("transactionId")).await,
                };
                answers.push(match queued {
                    Ok(statuses) => json!({
                        "status": 200,
                        "statuses": statuses
                            .iter()
                            .map(|s| json!({ "key": s.key, "state": s.state }))
                            .collect::<Vec<_>>(),
                    }),
                    Err(why) => json!({ "status": 400, "error": why }),
                });
            }
            let queue: Value = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(Value::from(answers), node["answers"], "{name}: answers");
            assert_eq!(queue, node["queue"], "{name}: queue");
        }
        tx.rollback().await.unwrap();
    }
}
