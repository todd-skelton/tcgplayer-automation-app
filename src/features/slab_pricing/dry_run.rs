//! A price-change preview's publication run against the imported inventory instead of eBay
//! (`dryRunSlabPublication`): the listing as imported is read as the seller's listing would be,
//! the plan is prepared from the preview, approved, claimed and checked, and its outcome recorded
//! with every step. No price is written; a live publication is not connected.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, PgConnection};

use super::publication::{self, Which, is_id, iso, millis};

/// The publisher a dry run is prepared, approved and run with (`importedPublisher`).
const PUBLISHER: &str = "imported-inventory-dry-run";
const VERSION: &str = "slab-publication-v1";
/// The longest a prepared plan stays approvable, unless its preview expires sooner.
const PLAN_MS: i64 = 5 * 60_000;
/// The oldest a listing read may be when it is checked.
const FRESH_MS: i64 = 60_000;
/// The largest plan saved, in bytes of JSON.
const MOST_PLAN_BYTES: usize = 16 * 1024;
const UNAVAILABLE: &str = "Unable to access slab publication.";
const OTHER_PUBLICATION: &str = "This intent already belongs to another publication.";

/// What went wrong reading the listing: the seller's listing could not be read as one
/// (`SlabPublisherError("unavailable")`), or the database failed.
struct Unavailable;

impl From<sqlx::Error> for Unavailable {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!("slab publication: {error}");
        Unavailable
    }
}

fn unavailable(error: sqlx::Error) -> String {
    tracing::error!("slab publication: {error}");
    UNAVAILABLE.to_owned()
}

/// A publication as saved (`StoredPublication`).
struct Saved {
    plan: Value,
    state: String,
    write_started_at: Option<DateTime<Utc>>,
}

/// A publication claimed to run, under its lease (`PublicationJob`).
struct Job {
    id: String,
    lease: String,
    saved: Saved,
}

type SavedRow = (Value, String, Option<DateTime<Utc>>);

fn saved((plan, state, write_started_at): SavedRow) -> Saved {
    Saved {
        plan,
        state,
        write_started_at,
    }
}

/// `getPublication`.
async fn publication(conn: &mut PgConnection, id: &str) -> Result<Option<Saved>, String> {
    if !is_id(id) {
        return Err("Choose a publication intent.".to_owned());
    }
    let row: Option<SavedRow> = sqlx::query_as(
        "SELECT plan, state, write_started_at FROM slab_publications WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    Ok(row.map(saved))
}

/// Each once, in the order first given (`[...new Set(items)]`).
fn distinct<T: PartialEq>(items: Vec<T>) -> Vec<T> {
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        if !kept.contains(&item) {
            kept.push(item);
        }
    }
    kept
}

/// A three-letter currency code.
fn currency(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
}

/// JavaScript's `===` between two numbers, either of which may be null.
fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}

/// `listingState`: the seller's listing as read, kept to the fields a publication records, or
/// unavailable when any is not what a listing has.
fn listing_state(read: &Value) -> Result<Value, Unavailable> {
    let account = |key: &str| {
        read[key].as_str().is_some_and(|s| {
            (1..=80).contains(&s.len())
                && s.bytes()
                    .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-'))
        })
    };
    let item = read["itemId"]
        .as_str()
        .is_some_and(|s| (9..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()));
    let variation = read["variationKey"]
        .as_str()
        .is_some_and(|s| s.encode_utf16().count() <= 160);
    let price = &read["price"];
    let amount = price["amount"].as_f64().is_some_and(|a| a > 0.0 && a < 1e9);
    let quantity = read["quantity"]
        .as_f64()
        .is_some_and(|q| q.fract() == 0.0 && (0.0..=1e7).contains(&q));
    let state = matches!(read["state"].as_str(), Some("active" | "ended" | "sold"));
    let format = matches!(
        read["format"].as_str(),
        Some("fixed-price" | "auction" | "unknown")
    );
    let title = read["title"].as_str().is_some_and(|t| {
        !t.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
            && t.encode_utf16().count() <= 500
    });
    let revision = read["protectedRevision"].as_str().is_some_and(|r| {
        r.len() == 64 && r.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9'))
    });
    let observed = read["observedAt"].as_str().and_then(millis);
    let shipping = &read["shipping"];
    let field = |key: &str| shipping.get(key).unwrap_or(&Value::Null);
    let (charged, paid_in, policy) = (field("amount"), field("currency"), field("policyId"));
    let shipping_ok = ["amount", "currency", "policyId"]
        .iter()
        .all(|key| shipping.get(key).is_some())
        && (charged.is_null() || charged.as_f64().is_some_and(|a| a >= 0.0))
        && (paid_in.is_null() || currency(paid_in))
        && (policy.is_null()
            || policy
                .as_str()
                .is_some_and(|p| p.encode_utf16().count() <= 80));
    let valid = account("seller")
        && account("accountSeller")
        && item
        && variation
        && amount
        && currency(&price["currency"])
        && quantity
        && state
        && format
        && title
        && revision
        && observed.is_some()
        && read["supported"].is_boolean()
        && shipping_ok;
    if !valid {
        return Err(Unavailable);
    }
    let certificate = match &read["certificate"] {
        Value::Null => Value::Null,
        certificate => {
            let grader = certificate["grader"].as_str().unwrap_or_default();
            let number = certificate["certificateNumber"]
                .as_str()
                .unwrap_or_default();
            json!({ "grader": grader.to_uppercase(), "certificateNumber": number })
        }
    };
    Ok(json!({
        "seller": read["seller"],
        "accountSeller": read["accountSeller"],
        "itemId": read["itemId"],
        "variationKey": read["variationKey"],
        "price": { "amount": price["amount"], "currency": price["currency"] },
        "quantity": read["quantity"],
        "state": read["state"],
        "format": read["format"],
        "certificate": certificate,
        "title": read["title"],
        "shipping": { "amount": charged, "currency": paid_in, "policyId": policy },
        "protectedRevision": read["protectedRevision"],
        "observedAt": iso(observed.unwrap_or_default()),
        "supported": read["supported"],
    }))
}

/// `listingConflicts`: why the listing as read is no longer the one the plan was prepared for,
/// at `price`, as of `now` (and, after a write, not before it started).
fn listing_conflicts(
    plan: &Value,
    row: &Value,
    price: &Value,
    now: i64,
    not_before: Option<i64>,
) -> Vec<&'static str> {
    let (target, certificate, before) = (&plan["target"], &plan["certificate"], &plan["before"]);
    let mut reasons = Vec::new();
    if row["accountSeller"] != target["seller"] || row["seller"] != target["seller"] {
        reasons.push("wrong-seller");
    }
    if row["itemId"] != target["itemId"] || row["variationKey"] != target["variationKey"] {
        reasons.push("wrong-listing");
    }
    let variation = row["variationKey"].as_str().is_some_and(|v| !v.is_empty());
    if row["supported"] != true || row["format"] != "fixed-price" || variation {
        reasons.push("unsupported-listing");
    }
    if row["state"] != "active" || row["quantity"].as_f64() != Some(1.0) {
        reasons.push("listing-unavailable");
    }
    let held = &row["certificate"];
    if held.is_null()
        || held["grader"] != certificate["grader"]
        || held["certificateNumber"] != certificate["certificateNumber"]
    {
        reasons.push("certificate-changed");
    }
    if row["price"]["currency"] != price["currency"]
        || !same(&row["price"]["amount"], &price["amount"])
    {
        reasons.push("price-changed");
    }
    let (shipping, then) = (&row["shipping"], &before["shipping"]);
    if row["protectedRevision"] != before["protectedRevision"]
        || row["title"] != before["title"]
        || !same(&shipping["amount"], &then["amount"])
        || shipping["currency"] != then["currency"]
        || shipping["policyId"] != then["policyId"]
    {
        reasons.push("listing-settings-changed");
    }
    let observed = row["observedAt"]
        .as_str()
        .and_then(millis)
        .unwrap_or_default();
    if observed > now || now - observed > FRESH_MS || not_before.is_some_and(|at| observed < at) {
        reasons.push("listing-read-stale");
    }
    reasons
}

/// `importedPublisher(...).read`: the listing as imported, read as the seller's listing would be,
/// its protected fields fingerprinted by its revision.
async fn read_imported(
    conn: &mut PgConnection,
    listing: &str,
    now: i64,
) -> Result<Value, Unavailable> {
    type Row = (
        String,
        String,
        String,
        String,
        Value,
        String,
        i32,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT s.id::text, s.seller, s.item_id, s.variation_key, s.snapshot, s.state, s.revision, i.grader, i.certificate_number
         FROM slab_inventory s LEFT JOIN slab_identities i ON i.id = s.identity_id WHERE s.id = $1::uuid",
    )
    .bind(listing)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((
        id,
        seller,
        item_id,
        variation_key,
        snapshot,
        state,
        revision,
        Some(grader),
        Some(number),
    )) = row
    else {
        return Err(Unavailable);
    };
    let fingerprint = hex::encode(Sha256::digest(format!("{id}:{revision}")));
    let supported = snapshot["format"] == "fixed-price" && variation_key.is_empty();
    listing_state(&json!({
        "seller": seller,
        "accountSeller": seller,
        "itemId": item_id,
        "variationKey": variation_key,
        "price": snapshot["price"],
        "quantity": snapshot["quantity"],
        "state": if state == "missing" { "ended" } else { state.as_str() },
        "format": snapshot["format"],
        "certificate": { "grader": grader, "certificateNumber": number },
        "title": snapshot["title"],
        "shipping": snapshot["shipping"],
        "protectedRevision": fingerprint,
        "observedAt": iso(now),
        "supported": supported,
    }))
}

/// `currentPlan`: why a prepared plan can no longer run: it expired, or its preview conflicts.
async fn plan_changes(
    conn: &mut PgConnection,
    plan: &Value,
    now: DateTime<Utc>,
) -> Result<Vec<String>, String> {
    let at = now.timestamp_millis();
    let expires = plan["expiresAt"].as_str().and_then(millis);
    let created_later = plan["createdAt"]
        .as_str()
        .and_then(millis)
        .is_some_and(|c| c > at);
    if plan["version"] != VERSION || expires.is_none_or(|e| e <= at) || created_later {
        return Ok(vec!["plan-expired".to_owned()]);
    }
    let preview = plan["previewId"].as_str().unwrap_or_default();
    match publication::saved_preview(conn, Which::Id(preview), now).await? {
        Some((read, _)) if read.id == preview => Ok(read.conflicts),
        _ => Ok(vec!["preview-unavailable".to_owned()]),
    }
}

/// Whether the plan is a dry run of the imported inventory (`providerMatches`).
fn imported(plan: &Value) -> bool {
    plan["publisherId"] == PUBLISHER && plan["mode"] != "live"
}

/// `prepareSlabPublication` with the imported publisher: the dry run's plan saved under its
/// intent, or the one already saved for it.
async fn prepare(
    conn: &mut PgConnection,
    intent: &str,
    preview_id: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    if !is_id(intent) || !is_id(preview_id) {
        return Err("Provide a saved preview and a new publication intent.".to_owned());
    }
    if let Some(previous) = publication(conn, intent).await? {
        let plan = &previous.plan;
        let same_run = plan["previewId"] == preview_id
            && plan["mode"] == "dry-run"
            && plan["publisherId"] == PUBLISHER
            && plan["restoreOf"].is_null();
        return if same_run {
            Ok(())
        } else {
            Err(OTHER_PUBLICATION.to_owned())
        };
    }
    let preview = publication::saved_preview(conn, Which::Id(preview_id), now).await?;
    let Some((preview, saved)) = preview.filter(|(p, _)| p.conflicts.is_empty()) else {
        return Err("The preview changed or expired. Prepare a new review.".to_owned());
    };
    let listing = &preview.plan.inventory.id;
    let confirmed: Option<(String, String)> = sqlx::query_as(
        "SELECT i.grader, i.certificate_number FROM slab_inventory s JOIN slab_identities i ON i.id = s.identity_id WHERE s.id = $1::uuid AND i.status = 'confirmed'",
    )
    .bind(listing)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    let Some((grader, number)) = confirmed else {
        return Err("Confirm the listing certificate before preparing publication.".to_owned());
    };
    let at = now.timestamp_millis();
    let before = read_imported(conn, listing, at)
        .await
        .map_err(|Unavailable| UNAVAILABLE.to_owned())?;
    let inventory = &saved["inventory"];
    let plan_target = json!({ "seller": inventory["seller"], "itemId": inventory["itemId"], "variationKey": inventory["variationKey"] });
    let certificate = json!({ "grader": grader.to_uppercase(), "certificateNumber": number });
    let checked = json!({ "target": plan_target, "certificate": certificate, "before": before });
    let mut reasons = listing_conflicts(&checked, &before, &saved["oldPrice"], at, None);
    let (snapshot, shipping) = (&inventory["snapshot"], &before["shipping"]);
    let imported_shipping = &snapshot["shipping"];
    let policy = imported_shipping.get("policyId").unwrap_or(&Value::Null);
    if before["title"] != snapshot["title"]
        || !same(&shipping["amount"], &imported_shipping["amount"])
        || shipping["currency"] != imported_shipping["currency"]
        || (!policy.is_null() && *policy != shipping["policyId"])
    {
        reasons.push("imported-listing-changed");
    }
    let expires = saved["expiresAt"]
        .as_str()
        .and_then(millis)
        .map(|e| e.min(at + PLAN_MS))
        .filter(|&e| e > at);
    if expires.is_none() {
        reasons.push("preview-expired");
    }
    if !reasons.is_empty() {
        return Err(format!(
            "Prepare a new review: {}.",
            distinct(reasons).join(", ")
        ));
    }
    let plan = json!({
        "version": VERSION,
        "mode": "dry-run",
        "publisherId": PUBLISHER,
        "previewId": preview.id,
        "target": checked["target"],
        "certificate": checked["certificate"],
        "before": before,
        "price": saved["newPrice"],
        "restoreOf": null,
        "createdAt": iso(at),
        "expiresAt": iso(expires.unwrap_or_default()),
    });
    if !plan_changes(conn, &plan, now).await?.is_empty() {
        return Err("The review changed during the seller read. Prepare it again.".to_owned());
    }
    save(conn, intent, &plan).await
}

/// `savePublication`: the plan saved as prepared, with its first step, once under its intent.
async fn save(conn: &mut PgConnection, intent: &str, plan: &Value) -> Result<(), String> {
    if plan.to_string().len() > MOST_PLAN_BYTES {
        return Err("The publication plan exceeds its size limit.".to_owned());
    }
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let target = &plan["target"];
    let inserted = sqlx::query(
        "INSERT INTO slab_publications(id,preview_id,restore_of,seller,item_id,variation_key,mode,plan,state)
         VALUES($1::uuid,$2::uuid,NULL,$3,$4,$5,$6,$7,'prepared') ON CONFLICT(id) DO NOTHING",
    )
    .bind(intent)
    .bind(plan["previewId"].as_str())
    .bind(target["seller"].as_str())
    .bind(target["itemId"].as_str())
    .bind(target["variationKey"].as_str())
    .bind(plan["mode"].as_str())
    .bind(plan)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected()
        > 0;
    if inserted {
        sqlx::query(
            "INSERT INTO slab_publication_events(publication_id,state) VALUES($1::uuid,'prepared')",
        )
        .bind(intent)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    } else {
        let previous: Option<Value> =
            sqlx::query_scalar("SELECT plan FROM slab_publications WHERE id=$1::uuid")
                .bind(intent)
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?;
        let same_plan = previous.is_some_and(|p| {
            ["previewId", "mode", "publisherId", "restoreOf"]
                .iter()
                .all(|k| p[k] == plan[k])
        });
        if !same_plan {
            return Err("This intent already belongs to a different publication plan.".to_owned());
        }
    }
    tx.commit().await.map_err(unavailable)
}

/// `approveSlabPublication`: a prepared plan still current approved to run.
async fn approve(conn: &mut PgConnection, id: &str, now: DateTime<Utc>) -> Result<(), String> {
    let Some(row) = publication(conn, id).await? else {
        return Err("Publication not found.".to_owned());
    };
    if !imported(&row.plan) {
        return Err("Reconnect the publication's original provider.".to_owned());
    }
    if row.state != "prepared" {
        return Ok(());
    }
    if !plan_changes(conn, &row.plan, now).await?.is_empty() {
        return Err(
            "The plan changed or expired. Prepare a new review before approving.".to_owned(),
        );
    }
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let approved = sqlx::query(
        "UPDATE slab_publications SET state='approved',updated_at=clock_timestamp() WHERE id=$1::uuid AND state='prepared' AND (plan->>'expiresAt')::timestamptz>clock_timestamp()",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|error| match &error {
        sqlx::Error::Database(e) if e.code().as_deref() == Some("23505") => {
            "Another approved or unresolved publication already owns this listing.".to_owned()
        }
        _ => unavailable(error),
    })?
    .rows_affected()
        > 0;
    if approved {
        sqlx::query(
            "INSERT INTO slab_publication_events(publication_id,state) VALUES($1::uuid,'approved')",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    }
    tx.commit().await.map_err(unavailable)
}

/// `claimPublication`: the publication leased for 90 seconds to run, when it is approved or a
/// run of it stopped, and has not been tried too often.
async fn claim(conn: &mut PgConnection, id: &str) -> Result<Option<Job>, String> {
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let row: Option<(Value, String, Option<DateTime<Utc>>, String)> = sqlx::query_as(
        "UPDATE slab_publications SET state=CASE WHEN state IN ('writing','reconcile') THEN 'reconcile' ELSE 'checking' END,
           attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
         WHERE id=$1::uuid AND (attempts<20 OR state IN ('writing','reconcile')) AND (state='approved' OR (state IN ('checking','writing','reconcile') AND (lease_until IS NULL OR lease_until<=clock_timestamp())))
         RETURNING plan,state,write_started_at,lease_id::text",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unavailable)?;
    let Some((plan, state, write_started_at, lease)) = row else {
        tx.commit().await.map_err(unavailable)?;
        return Ok(None);
    };
    sqlx::query("INSERT INTO slab_publication_events(publication_id,state,reason) VALUES($1::uuid,$2,'execution-claimed')")
        .bind(id)
        .bind(&state)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Some(Job {
        id: id.to_owned(),
        lease,
        saved: saved((plan, state, write_started_at)),
    }))
}

/// `finishPublication`: the claimed run moved to `state`, when that follows from where it stands,
/// with the step recorded. False when the lease ran out or the move is not allowed.
async fn finish(
    conn: &mut PgConnection,
    job: &Job,
    state: &str,
    reason: Option<&str>,
    observation: Option<&Value>,
) -> Result<bool, String> {
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let moved = sqlx::query(
        "UPDATE slab_publications SET state=$3,reason=$4,updated_at=clock_timestamp(),
           write_started_at=CASE WHEN $3='writing' THEN clock_timestamp() ELSE write_started_at END,
           lease_id=CASE WHEN $3='writing' THEN lease_id ELSE NULL END,lease_until=CASE WHEN $3='writing' THEN lease_until ELSE NULL END
         WHERE id=$1::uuid AND lease_id=$2::uuid AND lease_until>clock_timestamp() AND state IN ('checking','writing','reconcile')
           AND ((state='checking' AND $3 IN ('writing','conflict','failed','dry-run')) OR (state='writing' AND $3 IN ('reconcile','confirmed','failed')) OR (state='reconcile' AND $3 IN ('reconcile','confirmed')))
           AND ($3<>'writing' OR (state='checking' AND mode='live' AND (plan->>'expiresAt')::timestamptz>clock_timestamp()))
           AND ($3<>'confirmed' OR (state IN ('writing','reconcile') AND mode='live'))
           AND ($3<>'dry-run' OR (state='checking' AND mode='dry-run'))",
    )
    .bind(&job.id)
    .bind(&job.lease)
    .bind(state)
    .bind(reason)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected()
        > 0;
    if moved {
        sqlx::query("INSERT INTO slab_publication_events(publication_id,state,reason,observation) VALUES($1::uuid,$2,$3,$4)")
            .bind(&job.id)
            .bind(state)
            .bind(reason)
            .bind(observation)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
    }
    tx.commit().await.map_err(unavailable)?;
    Ok(moved)
}

/// `reconcile`: a run whose write may have started confirmed by reading the listing back. A dry
/// run never writes, so this only settles a run left mid-write.
async fn reconcile(
    conn: &mut PgConnection,
    job: &Job,
    listing: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let Some(started) = job.saved.write_started_at else {
        return finish(
            conn,
            job,
            "reconcile",
            Some("write-boundary-unavailable"),
            None,
        )
        .await;
    };
    let at = now.timestamp_millis();
    match read_imported(conn, listing, at).await {
        Ok(read) => {
            let plan = &job.saved.plan;
            let conflicts = listing_conflicts(
                plan,
                &read,
                &plan["price"],
                at,
                Some(started.timestamp_millis()),
            );
            let (state, reason) = if conflicts.is_empty() {
                (
                    "confirmed",
                    "price-and-protected-fields-confirmed".to_owned(),
                )
            } else {
                ("reconcile", format!("readback:{}", conflicts.join(",")))
            };
            finish(conn, job, state, Some(&reason), Some(&read)).await
        }
        Err(Unavailable) => {
            finish(conn, job, "reconcile", Some("readback:unavailable"), None).await
        }
    }
}

/// `runSlabPublication` with the imported publisher: the claimed plan checked against the
/// listing as imported, its outcome recorded.
async fn run(
    conn: &mut PgConnection,
    id: &str,
    listing: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let Some(row) = publication(conn, id).await? else {
        return Err("Publication not found.".to_owned());
    };
    if !imported(&row.plan) {
        return Err("Reconnect the publication's original provider.".to_owned());
    }
    let Some(job) = claim(conn, id).await? else {
        return Ok(());
    };
    if job.saved.state == "reconcile" {
        reconcile(conn, &job, listing, now).await?;
        return Ok(());
    }
    let plan = &job.saved.plan;
    let changed = plan_changes(conn, plan, now).await;
    let checked = match changed {
        Ok(changed) if !changed.is_empty() => {
            finish(conn, &job, "conflict", Some(&changed.join(",")), None).await?;
            return Ok(());
        }
        Ok(_) => check(conn, plan, listing, now).await,
        Err(_) => Err(Unavailable),
    };
    match checked {
        Ok((conflicts, read)) if !conflicts.is_empty() => {
            finish(
                conn,
                &job,
                "conflict",
                Some(&conflicts.join(",")),
                Some(&read),
            )
            .await?;
        }
        Ok((_, read)) => {
            let reason = "imported-inventory-checked-no-price-write";
            finish(conn, &job, "dry-run", Some(reason), Some(&read)).await?;
        }
        Err(Unavailable) => {
            finish(conn, &job, "failed", Some("preflight:unavailable"), None).await?;
        }
    }
    Ok(())
}

/// The listing read and checked against the plan, and the plan against its preview again.
async fn check(
    conn: &mut PgConnection,
    plan: &Value,
    listing: &str,
    now: DateTime<Utc>,
) -> Result<(Vec<String>, Value), Unavailable> {
    let at = now.timestamp_millis();
    let read = read_imported(conn, listing, at).await?;
    let mut conflicts: Vec<String> =
        listing_conflicts(plan, &read, &plan["before"]["price"], at, None)
            .into_iter()
            .map(str::to_owned)
            .collect();
    conflicts.extend(
        plan_changes(conn, plan, now)
            .await
            .map_err(|_| Unavailable)?,
    );
    Ok((distinct(conflicts), read))
}

/// `dryRunSlabPublication`: the preview's publication prepared under `intent` (or the one
/// already prepared under it), approved and run against the imported inventory. Returns where
/// it stands, by its id; a refusal is its message.
pub async fn dry_run(
    conn: &mut PgConnection,
    intent: &str,
    preview: &str,
    now: DateTime<Utc>,
) -> Result<String, String> {
    let Some((read, _)) = publication::saved_preview(conn, Which::Id(preview), now).await? else {
        return Err("Preview not found.".to_owned());
    };
    let listing = read.plan.inventory.id.clone();
    prepare(conn, intent, preview, now).await?;
    approve(conn, intent, now).await?;
    run(conn, intent, &listing, now).await?;
    match publication(conn, intent).await? {
        Some(_) => Ok(intent.to_owned()),
        None => Err(UNAVAILABLE.to_owned()),
    }
}
