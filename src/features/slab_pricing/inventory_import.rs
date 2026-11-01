//! Importing a snapshot of some of the seller's eBay listings, as a CSV (`parseInventoryCsv`) or
//! as listings entered by hand (`parseListingSnapshot`), saved by `reconcileInventory`; and tying
//! a listing to an identity: its certificate's, looked up with Alt (`resolveInventoryIdentity`),
//! or a confirmed one by hand (`assignInventoryIdentity`). An import never retires a listing it
//! leaves out; only a complete read of the seller's active listings from eBay could, and neither
//! app has one yet.
//!
//! Where a manual import can still differ from Node, on a request the Node app's own client never
//! sends: two item specifics whose names differ only in surrounding white space keep the value of
//! the one later in name order here, where Node kept the one later in the request.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    identity::{self, Record, Unresolved, certificate, normalized_certificate, text_field},
    inventory::{Expected, Refused, identity_conflicts, seller_account},
};
use crate::{
    csv_text::{self, Reading},
    features::{slab_connections::Gate, slab_evidence::alt::Alt},
};

/// Refused in Node's words.
const LISTING: &str =
    "Each listing needs an eBay item ID, title, valid price/currency, quantity, state and format.";
/// Any identity field refused (`SlabIdentityError`), as the route words it.
const FIELDS: &str = "Check the inventory request fields.";
const LISTING_AND_REVISION: &str = "Provide a listing ID and revision.";
const IDENTITY_AND_NOTE: &str = "Choose a confirmed identity and record a note.";
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
    once_each(table.rows.iter().map(snapshot))
}

/// `parseListingSnapshot` of a listing entered by hand: the listing as saved, with what it needs
/// reviewed, or why it is refused, in the order Node checks.
fn manual_listing(input: &Value) -> Result<Value, String> {
    // Reading a field of `null` is a TypeError, refused as a field.
    if input.is_null() {
        return Err(FIELDS.to_owned());
    }
    let item_id = field(&input["itemId"], 20)?;
    let title = field(&input["title"], 500)?;
    let currency = field(&input["price"]["currency"], 3)?.map(|c| c.to_uppercase());
    let amount = input["price"]["amount"].as_f64();
    let quantity = input["quantity"].as_f64();
    let state = input["state"].as_str().unwrap_or_default();
    let format = input["format"].as_str().unwrap_or_default();
    let valid = item_id
        .as_deref()
        .is_some_and(|i| (9..=20).contains(&i.len()) && i.bytes().all(|b| b.is_ascii_digit()))
        && currency
            .as_deref()
            .is_some_and(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
        && amount.is_some_and(|a| (0.0..=1e9).contains(&a))
        && quantity.is_some_and(|q| q.fract() == 0.0 && (0.0..=1e7).contains(&q))
        && ["active", "ended", "sold"].contains(&state)
        && ["fixed-price", "auction", "unknown"].contains(&format);
    let (Some(item_id), Some(title), Some(currency), Some(amount), Some(quantity), true) =
        (item_id, title, currency, amount, quantity, valid)
    else {
        return Err(LISTING.to_owned());
    };
    // `input.shipping?.amount ?? null`: a shipping that is not an object has no amount.
    let shipping = &input["shipping"];
    let shipping_amount = &shipping["amount"];
    let shipping_currency = field(&shipping["currency"], 3)?.map(|c| c.to_uppercase());
    let known = match shipping_amount {
        Value::Null => true,
        amount => amount.as_f64().is_some_and(|a| (0.0..=1e9).contains(&a)),
    };
    if !known
        || shipping_currency
            .as_deref()
            .is_some_and(|c| c.len() != 3 || !c.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return Err("Shipping must be a known amount or blank.".to_owned());
    }
    let Some(given) = input["specifics"].as_object().filter(|s| s.len() <= 100) else {
        return Err("Provide at most 100 item specifics.".to_owned());
    };
    let mut specifics = Map::new();
    for (key, values) in given {
        let name = field(&json!(key), 100)?;
        let values = values.as_array().filter(|v| v.len() <= 20);
        let (Some(name), Some(values)) = (name, values) else {
            return Err("Invalid item specifics.".to_owned());
        };
        let values = values
            .iter()
            .map(|v| field(v, 500).map(Option::unwrap_or_default))
            .collect::<Result<Vec<_>, _>>()?;
        specifics.insert(name, json!(values));
    }
    // `input.certificate ? normalizeCertificate(input.certificate) : null`.
    let certificate = match &input["certificate"] {
        Value::Null | Value::Bool(false) => Value::Null,
        Value::String(s) if s.is_empty() => Value::Null,
        Value::Number(n) if n.as_f64() == Some(0.0) => Value::Null,
        given => {
            let (grader, number) =
                normalized_certificate(&given["grader"], &given["certificateNumber"])
                    .map_err(|_| FIELDS.to_owned())?;
            json!({ "grader": grader, "certificateNumber": number })
        }
    };
    let mut reasons = Vec::new();
    if certificate.is_null() {
        reasons.push("certificate-required".to_owned());
    }
    if quantity > 1.0 {
        reasons.push("multiple-items-share-certificate".to_owned());
    }
    if names_a_lot(&title) {
        reasons.push("unsupported-lot-review-listing".to_owned());
    }
    if format != "fixed-price" {
        reasons.push("fixed-price-listing-required".to_owned());
    }
    let Some(given) = input["reviewReasons"].as_array().filter(|r| r.len() <= 30) else {
        return Err("Invalid listing review reasons.".to_owned());
    };
    for reason in given {
        if let Some(reason) = field(reason, 100)? {
            reasons.push(reason);
        }
    }
    // A set, sorted as JavaScript sorts text: by UTF-16 unit.
    reasons.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    reasons.dedup();
    // `normalizeExpectedIdentity(input.expected)`: none is `{}`, `null` a TypeError.
    let expected = match input.get("expected") {
        None => Expected::default(),
        Some(given) if given.is_null() => return Err(FIELDS.to_owned()),
        Some(given) => identity::expected(given).map_err(|_| FIELDS.to_owned())?,
    };
    Ok(json!({
        "itemId": item_id,
        "variationKey": field(&input["variationKey"], 160)?.unwrap_or_default(),
        "sku": field(&input["sku"], 200)?,
        "title": title,
        "price": { "amount": js_number(amount), "currency": currency },
        "shipping": {
            "amount": shipping_amount.as_f64().map_or(Value::Null, js_number),
            "currency": shipping_currency,
            "policyId": field(&shipping["policyId"], 80)?,
        },
        "quantity": js_number(quantity),
        "state": state,
        "format": format,
        "certificate": certificate,
        "expected": expected_json(&expected),
        "specifics": specifics,
        "reviewReasons": reasons,
    }))
}

/// What a listing is expected to be, as Node saves it.
fn expected_json(expected: &Expected) -> Value {
    json!({
        "name": expected.name,
        "game": expected.game,
        "language": expected.language,
        "set": expected.set,
        "cardNumber": expected.card_number,
        "year": expected.year,
        "edition": expected.edition,
        "finish": expected.finish,
        "stamp": expected.stamp,
        "gradeNumber": expected.grade_number.map_or(Value::Null, js_number),
        "gradeLabel": expected.grade_label,
        "qualifier": expected.qualifier,
        "autograph": expected.autograph,
    })
}

/// `parseInventoryImport` of listings entered by hand: each listing, once per item and variation.
fn manual_listings(listings: &Value) -> Result<Vec<Value>, String> {
    let Some(listings) = listings.as_array().filter(|l| l.len() <= MOST_LISTINGS) else {
        return Err(
            "Provide a bounded, dated inventory import. CSV and manual imports are always partial."
                .to_owned(),
        );
    };
    once_each(listings.iter().map(manual_listing))
}

/// The listings read, refused when one repeats another's item and variation (`listingKey`).
fn once_each(listings: impl Iterator<Item = Result<Value, String>>) -> Result<Vec<Value>, String> {
    let mut seen = std::collections::HashSet::new();
    listings
        .map(|listing| {
            let listing = listing?;
            let key = json!([listing["itemId"], listing["variationKey"]]).to_string();
            if !seen.insert(key) {
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

fn unavailable(error: sqlx::Error) -> Refused {
    eprintln!("slab inventory import: {error}");
    Refused::Unavailable
}

async fn account_revision(conn: &mut PgConnection, seller: &str) -> Result<i64, Refused> {
    let revision: Option<i32> =
        sqlx::query_scalar("SELECT revision FROM slab_inventory_accounts WHERE seller = $1")
            .bind(seller)
            .fetch_optional(&mut *conn)
            .await
            .map_err(unavailable)?;
    Ok(revision.map_or(0, i64::from))
}

/// The seller, as saved, when the inventory is at the revision the page showed: what every import
/// checks first.
pub async fn current(
    conn: &mut PgConnection,
    seller: &str,
    revision: i64,
) -> Result<String, Refused> {
    let seller = seller_account(seller)?;
    if !(0..=9_007_199_254_740_991).contains(&revision) {
        return Err(Refused::Invalid(
            "Provide the current inventory revision.".to_owned(),
        ));
    }
    if revision != account_revision(conn, &seller).await? {
        return Err(Refused::Conflict("Reload inventory before importing."));
    }
    Ok(seller)
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
) -> Result<Imported, Refused> {
    let seller = current(conn, seller, revision).await?;
    let listings = listings(csv)?;
    reconcile(conn, &seller, revision, &listings, "csv", now).await
}

/// The `import-manual` route: listings entered by hand, saved as [`import_csv`] saves a file's.
pub async fn import_manual(
    conn: &mut PgConnection,
    seller: &str,
    revision: i64,
    listings: &Value,
    now: DateTime<Utc>,
) -> Result<Imported, Refused> {
    let seller = current(conn, seller, revision).await?;
    let listings = manual_listings(listings)?;
    reconcile(conn, &seller, revision, &listings, "manual", now).await
}

/// `reconcileInventory` of a partial import from `source`: each listing saved as of `now` over
/// the inventory revision read, in one transaction.
async fn reconcile(
    conn: &mut PgConnection,
    seller: &str,
    revision: i64,
    listings: &[Value],
    source: &str,
    now: DateTime<Utc>,
) -> Result<Imported, Refused> {
    let observed = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    sqlx::query("INSERT INTO slab_inventory_accounts (seller) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(seller)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let (current, observed_at): (i32, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT revision, observed_at FROM slab_inventory_accounts WHERE seller = $1 FOR UPDATE",
    )
    .bind(seller)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    let at = now.timestamp_millis();
    if i64::from(current) != revision || observed_at.is_some_and(|o| o.timestamp_millis() > at) {
        return Err(Refused::Conflict(
            "Inventory changed while this import was running. Start a new import.",
        ));
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
         SELECT gen_random_uuid(), $1, x.item_id, x.variation_key, x.snapshot, $4, x.snapshot->>'state', $3::timestamptz, i.id,
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
    .bind(seller)
    .bind(Value::Array(rows))
    .bind(&observed)
    .bind(source)
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?;
    sqlx::query(
        "UPDATE slab_inventory_accounts SET revision = revision + 1, observed_at = $2::timestamptz, imported_at = clock_timestamp() WHERE seller = $1",
    )
    .bind(seller)
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
) -> Result<(), Refused> {
    let seller = seller_account(seller)?;
    if !id_like(listing) || !(1..=9_007_199_254_740_991).contains(&revision) {
        return Err(Refused::Invalid(LISTING_AND_REVISION.to_owned()));
    }
    if !id_like(identity) {
        return Err(Refused::Invalid(IDENTITY_AND_NOTE.to_owned()));
    }
    if note.trim().is_empty() || note.encode_utf16().count() > 1000 {
        return Err(Refused::Invalid(
            "Record the reason for this listing identity correction.".to_owned(),
        ));
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
        return Err(Refused::Conflict(
            "Reload the listing and choose a confirmed identity.",
        ));
    }
    Ok(())
}

/// How a listing's certificate was resolved.
#[derive(Debug)]
pub enum Resolved {
    /// The listing was tied to an identity by hand, which stays: the one it is tied to.
    ByHand { identity_id: Option<String> },
    /// The listing is tied to its certificate's identity, and expects this of it.
    Looked {
        record: Box<Record>,
        expected: Box<Expected>,
    },
}

impl Resolved {
    /// The identity looked up, if one was.
    pub fn record(self) -> Option<Record> {
        match self {
            Resolved::ByHand { .. } => None,
            Resolved::Looked { record, .. } => Some(*record),
        }
    }

    /// Why the identity needs review, and where it disagrees with what the listing expects.
    pub fn review_reasons(&self) -> Vec<String> {
        match self {
            Resolved::ByHand { .. } => Vec::new(),
            Resolved::Looked { record, expected } => {
                let mut reasons = record.review_reasons.clone();
                reasons.extend(identity_conflicts(record.shown(), expected));
                reasons
            }
        }
    }
}

/// The `resolve-identity` route: the seller's listing, at the revision the page showed, tied to
/// its certificate's identity, looked up with Alt as [`identity::lookup`] does. A listing tied by
/// hand stays as it is; its revision moves only when its identity does. Refused in the route's
/// words, which include what the listing expects being unreadable.
pub async fn resolve<G: Gate>(
    conn: &mut PgConnection,
    alt: &Alt<'_, G>,
    seller: &str,
    listing: &str,
    revision: i64,
    cancel: impl Future<Output = ()> + Send,
) -> Result<Resolved, Refused> {
    let seller = seller_account(seller)?;
    if !id_like(listing) || !(1..=9_007_199_254_740_991).contains(&revision) {
        return Err(Refused::Invalid(LISTING_AND_REVISION.to_owned()));
    }
    type Row = (i64, Option<String>, Option<String>, Value);
    let row: Option<Row> = sqlx::query_as(
        "SELECT revision::int8, identity_source, identity_id::text, snapshot FROM slab_inventory WHERE seller = $1 AND id = $2::uuid",
    )
    .bind(&seller)
    .bind(listing)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    let Some((_, source, identity_id, snapshot)) = row.filter(|(at, ..)| *at == revision) else {
        return Err(Refused::Conflict(
            "Reload the listing before resolving its certificate.",
        ));
    };
    if source.as_deref() == Some("manual") {
        return Ok(Resolved::ByHand { identity_id });
    }
    let certificate = &snapshot["certificate"];
    if certificate.is_null() {
        return Err(Refused::Invalid(
            "Import a certificate or assign a reviewed identity to this listing.".to_owned(),
        ));
    }
    let fields = || Refused::Invalid(FIELDS.to_owned());
    let (Some(grader), Some(number)) = (
        certificate["grader"].as_str(),
        certificate["certificateNumber"].as_str(),
    ) else {
        return Err(fields());
    };
    let expected = identity::expected(&snapshot["expected"]).map_err(|_| fields())?;
    let record = identity::lookup(conn, alt, (grader, number), false, cancel)
        .await
        .map_err(|unresolved| match unresolved {
            Unresolved::Refused(_) => fields(),
            Unresolved::Provider(status) => Refused::Provider(status),
            Unresolved::Unavailable => Refused::Unavailable,
        })?;
    let updated = sqlx::query(
        "UPDATE slab_inventory SET identity_id = $4::uuid, identity_source = 'certificate',
           revision = revision + CASE WHEN identity_id IS DISTINCT FROM $4::uuid THEN 1 ELSE 0 END,
           updated_at = clock_timestamp()
         WHERE seller = $1 AND id = $2::uuid AND revision = $3",
    )
    .bind(&seller)
    .bind(listing)
    .bind(revision)
    .bind(&record.id)
    .execute(&mut *conn)
    .await
    .map_err(unavailable)?;
    if updated.rows_affected() == 0 {
        return Err(Refused::Conflict(
            "Listing changed during certificate lookup. Reload it.",
        ));
    }
    Ok(Resolved::Looked {
        record: Box::new(record),
        expected: Box::new(expected),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::{
        database::Database,
        features::slab_connections::{ConnectionStatus as Status, Lease, Provider, Transport},
    };

    #[derive(Clone)]
    struct Open;

    impl Gate for Open {
        async fn claim(&self, _: Provider) -> Result<Lease, Status> {
            Ok(Lease {
                id: "lease".into(),
                revision: 1,
                secret: "fixture".into(),
                user_agent: String::new(),
            })
        }

        async fn release(
            &self,
            _: Provider,
            _: &Lease,
            _: Status,
            _: chrono::DateTime<Utc>,
        ) -> Result<(), Status> {
            Ok(())
        }
    }

    /// Alt on this machine: each certificate's recorded answer, keeping what it was asked.
    async fn alt_stand_in(answers: Value) -> (Transport, Arc<Mutex<Vec<Value>>>) {
        use corten::axum::{Router, extract::Json, http::StatusCode};
        let asked = Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        let app = Router::new().fallback(move |Json(operation): Json<Value>| {
            let (kept, answers) = (kept.clone(), answers.clone());
            async move {
                let answer = &answers[operation["variables"]["certNumber"].as_str().unwrap()];
                kept.lock().unwrap().push(operation);
                let status = answer["status"].as_u64().unwrap_or(200) as u16;
                (
                    StatusCode::from_u16(status).unwrap(),
                    answer["body"].to_string(),
                )
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { corten::axum::serve(listener, app).await });
        (Transport::to(&origin, &origin), asked)
    }

    /// The lookups and listing resolutions in `.port-logs/slab-lookup-cases.json`, in order, on
    /// `slab-lookup-seed.sql` in a transaction rolled back, with Alt answering each certificate as
    /// recorded, against Node's `/api/slab-identities` lookup and `/api/slab-inventory`
    /// `resolve-identity` over the same answers (`.port-logs/slab-lookup-node.ts`): the record
    /// answered or why not, what Alt was asked, and every identity and listing after each.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn certificates_resolve_as_node_resolves_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let given: Value = serde_json::from_str(&read_log("slab-lookup-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("slab-lookup.node.json")).unwrap();
        let cases = given["cases"].as_array().unwrap();
        assert_eq!(cases.len(), node.len());
        let (transport, asked) = alt_stand_in(given["alt"].clone()).await;
        let alt = Alt {
            transport: &transport,
            gate: &Open,
        };
        let capture = read_log("slab-lookup-capture.sql");
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("slab-lookup-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let text = |k: &str| case[k].as_str().unwrap_or_default();
            let pending = std::future::pending();
            let lookup = text("kind") == "lookup";
            // A listing's resolution also answers where the identity disagrees with the listing.
            let answered = if lookup {
                let certificate = (text("grader"), text("certificateNumber"));
                let refresh = case["refresh"] == true;
                identity::lookup(&mut tx, &alt, certificate, refresh, pending)
                    .await
                    .map(|r| (Some(r), None))
                    .map_err(|unresolved| unresolved.message())
            } else {
                let revision = case["revision"].as_i64().unwrap();
                let (seller, id) = (text("seller"), text("id"));
                resolve(&mut tx, &alt, seller, id, revision, pending)
                    .await
                    .map(|resolved| (Some(resolved.review_reasons()), resolved.record()))
                    .map(|(reasons, record)| (record, reasons))
                    .map_err(|refused| refused.message())
            };
            let ours = match answered {
                Ok((Some(r), reasons)) => {
                    let mut ours = json!({ "record": {
                        "grader": r.grader, "certificateNumber": r.certificate_number,
                        "status": r.status, "revision": r.revision, "reviewReasons": r.review_reasons,
                    } });
                    if let Some(reasons) = reasons {
                        ours["reviewReasons"] = json!(reasons);
                    }
                    ours
                }
                Ok((None, _)) => json!({ "manual": true }),
                Err(error) => json!({ "error": error }),
            };
            let mut answer = theirs["answer"].clone();
            if let (true, Some(answer)) = (lookup, answer.as_object_mut()) {
                // `identity::lookup` leaves what the identity disagrees with to the screen.
                answer.remove("reviewReasons");
            }
            let name = &case["name"];
            assert_eq!(ours, answer, "{name}");
            let alt_asked: Vec<Value> = std::mem::take(&mut *asked.lock().unwrap());
            let node_asked: Vec<Value> = theirs["asked"]
                .as_array()
                .unwrap()
                .iter()
                .inspect(|a| assert!(a["url"].as_str().unwrap().ends_with("/graphql/Cert")))
                .map(|a| a["body"].clone())
                .collect();
            assert_eq!(alt_asked, node_asked, "{name}: asked");
            let captured: Value =
                sqlx::query_scalar(&format!("SELECT captured FROM ({capture}) AS c"))
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            assert_eq!(captured, theirs["captured"], "{name}: saved");
        }
        tx.rollback().await.unwrap();
    }

    /// The posts in `.port-logs/slab-import-cases.json`, in order, on `slab-import-seed.sql`, in
    /// a transaction rolled back, against Node's `/api/slab-inventory` (`import-csv`,
    /// `assign-identity`; `.port-logs/slab-import-node.ts`) at the revision and time it ran
    /// each: the answer, and every listing and account after it.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn imports_and_assignments_save_as_node_saves_them() {
        saves_as_node("import").await;
    }

    /// The same for the listings entered by hand in `.port-logs/slab-manual-cases.json`
    /// (`import-manual`; `slab-import-node.ts manual`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn manual_imports_save_as_node_saves_them() {
        saves_as_node("manual").await;
    }

    async fn saves_as_node(cases: &str) {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let file = format!("slab-{cases}-cases.json");
        let cases: Vec<Value> = serde_json::from_str(&read_log(&file)).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log(&file.replace("-cases.json", ".node.json"))).unwrap();
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
            let at: DateTime<Utc> = theirs["at"].as_str().unwrap().parse().unwrap();
            let ours = match text("intent") {
                "assign-identity" => {
                    let (identity, note) = (text("identityId"), text("note"));
                    assign(
                        &mut tx,
                        text("seller"),
                        text("id"),
                        revision,
                        identity,
                        note,
                    )
                    .await
                }
                "import-manual" => {
                    let listings = &body["listings"];
                    import_manual(&mut tx, text("seller"), revision, listings, at)
                        .await
                        .map(|_| ())
                }
                _ => import_csv(&mut tx, text("seller"), revision, text("csv"), at)
                    .await
                    .map(|_| ()),
            };
            let ours = ours.map_err(|refused| refused.message());
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
