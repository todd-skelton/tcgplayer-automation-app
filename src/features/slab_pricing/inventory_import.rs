//! Importing a CSV snapshot of some of the seller's eBay listings (`parseInventoryCsv`,
//! `reconcileInventory`), and tying a listing to a confirmed identity by hand
//! (`assignInventoryIdentity`). A file never retires a listing it leaves out; only a complete
//! read of the seller's active listings could, and that stays the Node app's.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    identity::{certificate, text_field},
    inventory::seller_account,
};
use crate::csv_text::{self, Reading};

/// Refused in Node's words.
const LISTING: &str =
    "Each listing needs an eBay item ID, title, valid price/currency, quantity, state and format.";
/// Any identity field refused (`SlabIdentityError`), as the route words it.
const FIELDS: &str = "Check the inventory request fields.";
const UNAVAILABLE: &str = "Unable to update slab inventory. Try again.";
const REQUIRED: [&str; 7] = [
    "item_id", "title", "price", "currency", "quantity", "state", "format",
];
const MOST_BYTES: usize = 2 * 1024 * 1024;
const MOST_LISTINGS: usize = 5000;

/// A field refused as an identity field is, in the route's words.
fn field(value: &Value, max: usize) -> Result<Option<String>, String> {
    text_field(value, max).map_err(|_| FIELDS.to_owned())
}

/// A number as JavaScript keeps it: whole ones without a fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The CSV's `number`: plain digits with an optional fraction, else not a number.
fn number(value: Option<&str>) -> f64 {
    let plain = value.map(str::trim).filter(|v| {
        let (whole, fraction) = v.split_once('.').unwrap_or((v, "0"));
        !whole.is_empty()
            && !fraction.is_empty()
            && whole
                .bytes()
                .chain(fraction.bytes())
                .all(|b| b.is_ascii_digit())
    });
    plain.and_then(|v| v.parse().ok()).unwrap_or(f64::NAN)
}

/// Whether the title names a lot (`/\b(lot|bundle|mixed|assorted)\b/i`).
fn names_a_lot(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    ["lot", "bundle", "mixed", "assorted"].iter().any(|w| {
        lower.match_indices(w).any(|(at, _)| {
            let bytes = lower.as_bytes();
            !word(at.checked_sub(1).and_then(|i| bytes.get(i))) && !word(bytes.get(at + w.len()))
        })
    })
}

/// `normalizeExpectedIdentity` of the CSV's card and grade columns.
fn expected(row: &Map<String, Value>) -> Result<Value, String> {
    let at = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let grade = match at("grade_number") {
        Value::String(s) if !s.is_empty() => Some(number(Some(&s))),
        _ => None,
    };
    if grade.is_some_and(|g| !g.is_finite() || !(1.0..=10.0).contains(&g)) {
        return Err(FIELDS.to_owned());
    }
    let columns = [
        ("name", "card_name"),
        ("game", "game"),
        ("language", "language"),
        ("set", "set"),
        ("cardNumber", "card_number"),
        ("year", "year"),
        ("edition", "edition"),
        ("finish", "finish"),
        ("stamp", "stamp"),
    ];
    let mut out = Map::new();
    for (name, column) in columns {
        out.insert(name.to_owned(), json!(field(&at(column), 200)?));
    }
    out.insert(
        "gradeNumber".to_owned(),
        grade.map_or(Value::Null, js_number),
    );
    out.insert(
        "gradeLabel".to_owned(),
        json!(field(&at("grade_label"), 200)?),
    );
    out.insert("qualifier".to_owned(), Value::Null);
    out.insert("autograph".to_owned(), Value::Null);
    Ok(Value::Object(out))
}

/// `parseListingSnapshot` of a CSV row: the listing as saved, with what it needs reviewed, or
/// why it is refused, in the order Node checks.
fn snapshot(row: &Map<String, Value>) -> Result<Value, String> {
    let at = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let text = |key: &str| row.get(key).and_then(Value::as_str);
    // `row.x || null`: an empty field is none.
    let or_null = |key: &str| {
        text(key)
            .filter(|s| !s.is_empty())
            .map_or(Value::Null, |s| json!(s))
    };
    let item_id = field(&at("item_id"), 20)?;
    let title = field(&at("title"), 500)?;
    let currency = field(&at("currency"), 3)?.map(|c| c.to_uppercase());
    let amount = number(text("price"));
    let quantity = number(text("quantity"));
    let state = text("state").unwrap_or_default();
    let format = text("format").unwrap_or_default();
    let valid = item_id
        .as_deref()
        .is_some_and(|i| (9..=20).contains(&i.len()) && i.bytes().all(|b| b.is_ascii_digit()))
        && title.is_some()
        && currency
            .as_deref()
            .is_some_and(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
        && amount.is_finite()
        && (0.0..=1e9).contains(&amount)
        && quantity.fract() == 0.0
        && (0.0..=1e7).contains(&quantity)
        && ["active", "ended", "sold"].contains(&state)
        && ["fixed-price", "auction", "unknown"].contains(&format);
    let (Some(item_id), Some(title), Some(currency), true) = (item_id, title, currency, valid)
    else {
        return Err(LISTING.to_owned());
    };
    let shipping_amount = match text("shipping_amount") {
        Some(s) if !s.is_empty() => Some(number(Some(s))),
        _ => None,
    };
    let shipping_currency = field(&or_null("shipping_currency"), 3)?.map(|c| c.to_uppercase());
    if shipping_amount.is_some_and(|a| !a.is_finite() || !(0.0..=1e9).contains(&a))
        || shipping_currency
            .as_deref()
            .is_some_and(|c| c.len() != 3 || !c.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return Err("Shipping must be a known amount or blank.".to_owned());
    }
    let certificate = match (text("grader"), text("certificate_number")) {
        (Some(grader), Some(number)) if !grader.is_empty() && !number.is_empty() => {
            let (grader, number) = certificate(grader, number).map_err(|_| FIELDS.to_owned())?;
            json!({ "grader": grader, "certificateNumber": number })
        }
        _ => Value::Null,
    };
    let mut reasons = Vec::new();
    if certificate.is_null() {
        reasons.push("certificate-required");
    }
    if quantity > 1.0 {
        reasons.push("multiple-items-share-certificate");
    }
    if names_a_lot(&title) {
        reasons.push("unsupported-lot-review-listing");
    }
    if format != "fixed-price" {
        reasons.push("fixed-price-listing-required");
    }
    reasons.sort_unstable();
    Ok(json!({
        "itemId": item_id,
        "variationKey": field(&at("variation_key"), 160)?.unwrap_or_default(),
        "sku": field(&or_null("sku"), 200)?,
        "title": title,
        "price": { "amount": js_number(amount), "currency": currency },
        "shipping": {
            "amount": shipping_amount.map_or(Value::Null, js_number),
            "currency": shipping_currency,
            "policyId": field(&or_null("shipping_policy_id"), 80)?,
        },
        "quantity": js_number(quantity),
        "state": state,
        "format": format,
        "certificate": certificate,
        "expected": expected(row)?,
        "specifics": {},
        "reviewReasons": reasons,
    }))
}

/// `parseInventoryCsv`: each row's listing, once per item and variation.
fn listings(csv: &str) -> Result<Vec<Value>, String> {
    if csv.len() > MOST_BYTES {
        return Err("Inventory CSV must be at most 2 MiB.".to_owned());
    }
    let reading = Reading {
        greedy: true,
        trim_header: false,
    };
    let table = csv_text::read(csv, reading);
    if table.error.is_some()
        || REQUIRED
            .iter()
            .any(|r| !table.fields.iter().any(|f| f == r))
    {
        return Err(format!(
            "Provide a valid CSV with columns: {}.",
            REQUIRED.join(", ")
        ));
    }
    if table.rows.len() > MOST_LISTINGS {
        return Err(
            "Provide a bounded, dated inventory import. CSV and manual imports are always partial."
                .to_owned(),
        );
    }
    let mut seen = std::collections::HashSet::new();
    table
        .rows
        .iter()
        .map(|row| {
            let listing = snapshot(row)?;
            let key = (listing["itemId"].clone(), listing["variationKey"].clone());
            if !seen.insert(key.0.to_string() + &key.1.to_string()) {
                return Err("The import repeats a listing/variation identity.".to_owned());
            }
            Ok(listing)
        })
        .collect()
}

/// What an import saved.
#[derive(Debug, PartialEq, Eq)]
pub struct Imported {
    pub imported: usize,
    pub revision: i64,
}

fn unavailable(error: sqlx::Error) -> String {
    eprintln!("slab inventory import: {error}");
    UNAVAILABLE.to_owned()
}

async fn account_revision(conn: &mut PgConnection, seller: &str) -> Result<i64, String> {
    let revision: Option<i32> =
        sqlx::query_scalar("SELECT revision FROM slab_inventory_accounts WHERE seller = $1")
            .bind(seller)
            .fetch_optional(&mut *conn)
            .await
            .map_err(unavailable)?;
    Ok(revision.map_or(0, i64::from))
}

/// The `import-csv` route: the seller's listings in the CSV saved as of `now`, each tied to the
/// identity its certificate names unless one was tied by hand, over the inventory revision the
/// page showed. A listing changed counts a revision; the seller's inventory counts one.
pub async fn import_csv(
    conn: &mut PgConnection,
    seller: &str,
    revision: i64,
    csv: &str,
    now: DateTime<Utc>,
) -> Result<Imported, String> {
    let seller = seller_account(seller)?;
    if !(0..=9_007_199_254_740_991).contains(&revision) {
        return Err("Provide the current inventory revision.".to_owned());
    }
    if revision != account_revision(conn, &seller).await? {
        return Err("Reload inventory before importing.".to_owned());
    }
    let listings = listings(csv)?;
    let observed = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    sqlx::query("INSERT INTO slab_inventory_accounts (seller) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(&seller)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let (current, observed_at): (i32, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT revision, observed_at FROM slab_inventory_accounts WHERE seller = $1 FOR UPDATE",
    )
    .bind(&seller)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    let at = now.timestamp_millis();
    if i64::from(current) != revision || observed_at.is_some_and(|o| o.timestamp_millis() > at) {
        return Err(
            "Inventory changed while this import was running. Start a new import.".to_owned(),
        );
    }
    let rows: Vec<Value> = listings
        .iter()
        .map(|s| json!({ "item_id": s["itemId"], "variation_key": s["variationKey"], "snapshot": s }))
        .collect();
    sqlx::query(
        "WITH incoming AS (
           SELECT raw.item_id, raw.variation_key, raw.snapshot
           FROM jsonb_to_recordset($2::jsonb) AS raw(item_id text, variation_key text, snapshot jsonb)
         )
         INSERT INTO slab_inventory (id, seller, item_id, variation_key, snapshot, source, state, observed_at, identity_id, identity_source)
         SELECT gen_random_uuid(), $1, x.item_id, x.variation_key, x.snapshot, 'csv', x.snapshot->>'state', $3::timestamptz, i.id,
           CASE WHEN i.id IS NOT NULL THEN 'certificate' END
         FROM incoming x
         LEFT JOIN slab_identities i ON i.grader = x.snapshot->'certificate'->>'grader'
           AND i.certificate_number = x.snapshot->'certificate'->>'certificateNumber'
         ON CONFLICT (seller, item_id, variation_key) DO UPDATE SET
           snapshot = EXCLUDED.snapshot, source = EXCLUDED.source, state = EXCLUDED.state, observed_at = EXCLUDED.observed_at,
           identity_id = CASE WHEN slab_inventory.identity_source = 'manual' THEN slab_inventory.identity_id ELSE EXCLUDED.identity_id END,
           identity_source = CASE WHEN slab_inventory.identity_source = 'manual' THEN 'manual' ELSE EXCLUDED.identity_source END,
           revision = slab_inventory.revision + CASE WHEN slab_inventory.snapshot IS DISTINCT FROM EXCLUDED.snapshot
             OR slab_inventory.state IS DISTINCT FROM EXCLUDED.state
             OR (slab_inventory.identity_source IS DISTINCT FROM 'manual' AND slab_inventory.identity_id IS DISTINCT FROM EXCLUDED.identity_id) THEN 1 ELSE 0 END,
           updated_at = clock_timestamp()",
    )
    .bind(&seller)
    .bind(Value::Array(rows))
    .bind(&observed)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    sqlx::query(
        "UPDATE slab_inventory_accounts SET revision = revision + 1, observed_at = $2::timestamptz, imported_at = clock_timestamp() WHERE seller = $1",
    )
    .bind(&seller)
    .bind(&observed)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Imported {
        imported: listings.len(),
        revision: i64::from(current) + 1,
    })
}

/// A uuid as the route accepts one (`/^[a-f0-9-]{36}$/`).
fn id_like(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
}

/// The `assign-identity` route: the seller's listing, at the revision the page showed, tied by
/// hand to a confirmed identity, with why.
pub async fn assign(
    conn: &mut PgConnection,
    seller: &str,
    listing: &str,
    revision: i64,
    identity: &str,
    note: &str,
) -> Result<(), String> {
    let seller = seller_account(seller)?;
    if !id_like(listing) || !(1..=9_007_199_254_740_991).contains(&revision) {
        return Err("Provide a listing ID and revision.".to_owned());
    }
    if !id_like(identity) {
        return Err("Choose a confirmed identity and record a note.".to_owned());
    }
    if note.trim().is_empty() || note.encode_utf16().count() > 1000 {
        return Err("Record the reason for this listing identity correction.".to_owned());
    }
    let updated = sqlx::query(
        "UPDATE slab_inventory SET identity_id = $4::uuid, identity_source = 'manual', identity_note = $5,
           revision = revision + 1, updated_at = clock_timestamp() WHERE seller = $1 AND id = $2::uuid AND revision = $3
           AND EXISTS (SELECT 1 FROM slab_identities WHERE id = $4::uuid AND status = 'confirmed')",
    )
    .bind(&seller)
    .bind(listing)
    .bind(revision)
    .bind(identity)
    .bind(note.trim())
    .execute(&mut *conn)
    .await
    .map_err(unavailable)?;
    if updated.rows_affected() == 0 {
        return Err("Reload the listing and choose a confirmed identity.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// The posts in `.port-logs/slab-import-cases.json`, in order, on `slab-import-seed.sql`, in
    /// a transaction rolled back, against Node's `/api/slab-inventory` (`import-csv`,
    /// `assign-identity`; `.port-logs/slab-import-node.ts`) at the revision and time it ran
    /// each: the answer, and every listing and account after it.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn imports_and_assignments_save_as_node_saves_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("slab-import-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("slab-import.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let capture = read_log("slab-import-capture.sql");
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("slab-import-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let (name, body) = (&case["name"], &case["body"]);
            let text = |k: &str| body[k].as_str().unwrap_or_default();
            let revision = theirs["revision"].as_i64().unwrap();
            let ours = if text("intent") == "assign-identity" {
                assign(
                    &mut tx,
                    text("seller"),
                    text("id"),
                    revision,
                    text("identityId"),
                    text("note"),
                )
                .await
            } else {
                let at: DateTime<Utc> = theirs["at"].as_str().unwrap().parse().unwrap();
                import_csv(&mut tx, text("seller"), revision, text("csv"), at)
                    .await
                    .map(|_| ())
            };
            assert_eq!(ours.err().as_deref(), theirs["error"].as_str(), "{name}");
            let saved: Value = sqlx::query_scalar(capture.as_str())
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(saved, theirs["saved"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn a_lot_is_a_whole_word() {
        assert!(names_a_lot("Lot of two"));
        assert!(names_a_lot("Slab bundle-deal"));
        assert!(!names_a_lot("Lotus PSA 9"));
        assert!(!names_a_lot("MIXED_up"));
    }

    #[test]
    fn a_number_is_plain_digits() {
        assert_eq!(number(Some(" 0012.50 ")), 12.5);
        assert!(number(Some("1e3")).is_nan());
        assert!(number(Some("12.")).is_nan());
        assert!(number(Some("-1")).is_nan());
        assert!(number(None).is_nan());
    }
}
