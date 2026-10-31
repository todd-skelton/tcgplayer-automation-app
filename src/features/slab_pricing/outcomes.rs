//! Seller outcomes: the reviewed sales, cancellations and relists recorded for an imported
//! listing (`readSellerOutcomes`), and which of them can be counted
//! (`reconcileSellerOutcomes`), and importing reviewed ones from a CSV
//! (`importSellerOutcomeCsv`). Manually reviewed only; they change neither inventory nor prices.
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;

use super::inventory::seller_account;
use crate::{
    csv_text::{self, Reading},
    database::Database,
    features::inventory_economics::ledger::fingerprint::{js_json, sha256_hex},
    js_number,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub item_id: String,
    pub observations: Vec<Observation>,
    pub summary: Summary,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub seller: String,
    pub item_id: String,
    pub quantity: f64,
    pub kind: String,
    pub occurred_at: String,
    pub observed_at: String,
    pub price: Option<Price>,
    pub source: String,
    pub note: Option<String>,
    pub related_sale_id: Option<String>,
    pub next_item_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Sales neither cancelled nor held.
    pub sales: u32,
    pub cancellations: u32,
    pub relists: u32,
    /// Event ids whose claims conflict or do not link: left out of usable sales.
    pub unresolved: Vec<String>,
    pub cancelled_sale_ids: Vec<String>,
    /// Sales a cancellation that could not be checked names: not counted until reviewed.
    pub held_sale_ids: Vec<String>,
}

/// What an import saved.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub inserted: u32,
    pub supplied: u32,
    pub item_ids: Vec<String>,
}

impl Observation {
    /// One line, as the React panel wrote an observation.
    pub fn line(&self) -> String {
        let words = |code: &str| code.replace(['-', '_'], " ");
        let price = self.price.as_ref().map_or_else(
            || "Unknown".to_owned(),
            |p| format!("{} {:.2}", p.currency, p.amount),
        );
        let mut line = format!(
            "{} · listing {} · {} · {} · {} · {} · first recorded {} · {}",
            self.id,
            self.item_id,
            words(&self.kind),
            self.occurred_at,
            price,
            words(&self.source),
            self.observed_at,
            self.note.as_deref().unwrap_or("")
        );
        if let Some(sale) = &self.related_sale_id {
            line.push_str(&format!(" · related sale {sale}"));
        }
        if let Some(next) = &self.next_item_id {
            line.push_str(&format!(" · relisted as {next}"));
        }
        line
    }
}

fn time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// What makes two claims of one event the same claim.
type Signature<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    u64,
    Option<(u64, &'a str)>,
    &'a str,
);

fn signature(o: &Observation) -> Signature<'_> {
    (
        &o.seller,
        &o.item_id,
        &o.occurred_at,
        &o.kind,
        o.next_item_id.as_deref(),
        o.related_sale_id.as_deref(),
        o.quantity.to_bits(),
        o.price
            .as_ref()
            .map(|p| (p.amount.to_bits(), p.currency.as_str())),
        &o.source,
    )
}

/// A claim that cannot be counted as it stands.
fn unusable(
    row: &Observation,
    copies: &[Observation],
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> bool {
    let (Some(occurred), Some(observed)) = (time(&row.occurred_at), time(&row.observed_at)) else {
        return true;
    };
    let three_letters = |c: &str| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase());
    row.id.is_empty()
        || row.seller != seller
        || row.item_id != item_id
        || copies.iter().any(|c| signature(c) != signature(row))
        || !matches!(row.kind.as_str(), "sale" | "cancellation" | "relist")
        || !matches!(row.source.as_str(), "ebay-seller" | "reviewed-manual")
        || observed > as_of
        || occurred > observed
        || row.quantity != 1.0
        || row.price.as_ref().is_some_and(|p| {
            !p.amount.is_finite() || p.amount <= 0.0 || !three_letters(&p.currency)
        })
        || (row.source == "reviewed-manual"
            && row.note.as_deref().is_none_or(|n| n.trim().is_empty()))
        || (row.kind == "relist"
            && row
                .next_item_id
                .as_deref()
                .is_none_or(|n| n.is_empty() || n == row.item_id))
}

/// `reconcileSellerOutcomes` for one listing: the claims of each event agree and link, or the
/// event is unresolved; a cancellation that cannot be checked holds the sale it names.
fn reconcile(
    observations: &[Observation],
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> Summary {
    let mut order: Vec<&str> = Vec::new();
    let mut events: HashMap<&str, Vec<Observation>> = HashMap::new();
    for row in observations {
        if time(&row.observed_at).is_some_and(|at| at > as_of) {
            continue;
        }
        let copies = events.entry(&row.id).or_default();
        if copies.is_empty() {
            order.push(&row.id);
        }
        copies.push(row.clone());
    }
    let mut known: Vec<Observation> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut held: Vec<String> = Vec::new();
    let hold = |held: &mut Vec<String>, id: &str| {
        if !held.iter().any(|h| h == id) {
            held.push(id.to_owned());
        }
    };
    for id in order {
        let copies = &events[id];
        let row = copies
            .iter()
            .min_by(|a, b| a.observed_at.cmp(&b.observed_at))
            .expect("an event has a claim");
        if unusable(row, copies, seller, item_id, as_of) {
            unresolved.push(id.to_owned());
            for copy in copies {
                if copy.kind == "cancellation"
                    && let Some(sale) = copy.related_sale_id.as_deref().filter(|s| !s.is_empty())
                {
                    hold(&mut held, sale);
                }
            }
            continue;
        }
        known.push(row.clone());
    }
    let sales: HashMap<&str, &Observation> = known
        .iter()
        .filter(|r| r.kind == "sale")
        .map(|r| (r.id.as_str(), r))
        .collect();
    let mut cancelled: Vec<String> = Vec::new();
    for event in known.iter().filter(|r| r.kind == "cancellation") {
        let Some(related) = event.related_sale_id.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let sale = sales.get(related);
        let links = sale.is_some_and(|sale| {
            sale.item_id == event.item_id && time(&sale.occurred_at) <= time(&event.occurred_at)
        });
        if links {
            if !cancelled.iter().any(|c| c == related) {
                cancelled.push(related.to_owned());
            }
        } else {
            unresolved.push(event.id.clone());
            if let Some(sale) = sale {
                hold(&mut held, &sale.id);
            }
        }
    }
    let excluded: HashSet<&String> = cancelled.iter().chain(&held).collect();
    let count = |kind: &str| known.iter().filter(|r| r.kind == kind).count() as u32;
    Summary {
        sales: known
            .iter()
            .filter(|r| r.kind == "sale" && !excluded.contains(&r.id))
            .count() as u32,
        cancellations: count("cancellation"),
        relists: count("relist"),
        unresolved,
        cancelled_sale_ids: cancelled,
        held_sale_ids: held,
    }
}

/// `readSellerOutcomes`: every claim, up to `as_of`, of the events recorded for one of the
/// seller's listings, and what they add up to.
async fn review(
    conn: &mut sqlx::PgConnection,
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> Result<Review, String> {
    let seller = seller_account(seller)?;
    let listing = (9..=15).contains(&item_id.len()) && item_id.bytes().all(|b| b.is_ascii_digit());
    if !listing {
        return Err("Choose one listing item ID and a valid observation time.".to_owned());
    }
    // Every claim for these event ids, so an incorrect-item correction cannot hide a conflict.
    let rows: Vec<(Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT payload, observed_at FROM slab_seller_outcomes WHERE seller = $1 AND observed_at <= $3
        AND event_id IN (SELECT event_id FROM slab_seller_outcomes WHERE seller = $1 AND item_id = $2 AND observed_at <= $3)
        ORDER BY observed_at, event_id, content_hash LIMIT 251",
    )
    .bind(&seller)
    .bind(item_id)
    .bind(as_of)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if rows.len() > 250 {
        return Err("This listing has more than 250 outcome observations and needs a separate audit before evaluation.".to_owned());
    }
    let observations = rows
        .into_iter()
        .map(|(mut payload, observed_at)| {
            payload["observedAt"] = observed_at
                .to_rfc3339_opts(SecondsFormat::Millis, true)
                .into();
            serde_json::from_value::<Observation>(payload)
                .map_err(|e| format!("A seller outcome could not be read: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let summary = reconcile(&observations, &seller, item_id, as_of);
    Ok(Review {
        item_id: item_id.to_owned(),
        observations,
        summary,
    })
}

/// The outcomes recorded for one of the seller's listings, as of now.
pub async fn read(db: &Database, seller: &str, item_id: &str) -> Result<Review, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    review(&mut conn, seller, item_id, Utc::now()).await
}

/// The most of a file an import reads, and the most rows.
const MOST_BYTES: usize = 256 * 1024;
const MOST_ROWS: usize = 50;

const COLUMNS_MESSAGE: &str =
    "Provide 1–50 outcomes with event_id, item_id, kind, occurred_at, quantity and note columns.";

/// One reviewed outcome as Node saves it; its fields in Node's order, which its hash reads.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reviewed {
    id: String,
    seller: String,
    item_id: String,
    kind: String,
    occurred_at: String,
    quantity: u8,
    price: Option<Amount>,
    related_sale_id: Option<String>,
    next_item_id: Option<String>,
    source: &'static str,
    note: String,
}

#[derive(Debug, Serialize)]
struct Amount {
    amount: f64,
    currency: String,
}

/// `parseSellerOutcomeCsv`: each row checked, with the row Node names when one is wrong.
fn parse(csv: &str, seller: &str) -> Result<Vec<Reviewed>, String> {
    let seller = seller_account(seller)?;
    if csv.len() > MOST_BYTES {
        return Err("Provide at most 256 KiB of seller outcomes.".to_owned());
    }
    let table = csv_text::read(
        csv,
        Reading {
            greedy: true,
            trim_header: false,
        },
    );
    let required = [
        "event_id",
        "item_id",
        "kind",
        "occurred_at",
        "quantity",
        "note",
    ];
    if table.error.is_some()
        || table.rows.is_empty()
        || table.rows.len() > MOST_ROWS
        || required
            .iter()
            .any(|c| !table.fields.iter().any(|f| f == c))
    {
        return Err(COLUMNS_MESSAGE.to_owned());
    }
    let identifier = |v: &str| {
        (1..=120).contains(&v.len())
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    };
    let item = |v: &str| (9..=15).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit());
    table
        .rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let field = |name: &str| row.get(name).and_then(Value::as_str).unwrap_or_default();
            let trimmed = |name: &str| js_number::trim(field(name));
            let optional = |name: &str| Some(trimmed(name).to_owned()).filter(|v| !v.is_empty());
            let id = trimmed("event_id").to_owned();
            let item_id = trimmed("item_id").to_owned();
            let note = trimmed("note").to_owned();
            let kind = field("kind");
            let occurred_at = utc_time(trimmed("occurred_at"));
            let related_sale_id = optional("related_sale_id");
            let next_item_id = optional("next_item_id");
            let price_text = trimmed("price");
            let currency = trimmed("currency");
            let price_ok = if price_text.is_empty() {
                currency.is_empty()
            } else {
                let amount = js_number::number(price_text);
                cents(price_text)
                    && amount > 0.0
                    && amount < 1e9
                    && currency.len() == 3
                    && currency.bytes().all(|b| b.is_ascii_uppercase())
            };
            let priced = !price_text.is_empty();
            let fits = identifier(&id)
                && item(&item_id)
                && matches!(kind, "sale" | "cancellation" | "relist")
                && occurred_at.is_some()
                && trimmed("quantity") == "1"
                && !note.is_empty()
                && note.encode_utf16().count() <= 1000
                && price_ok
                && related_sale_id
                    .as_deref()
                    .is_none_or(|r| identifier(r) && r != id)
                && next_item_id
                    .as_deref()
                    .is_none_or(|n| item(n) && n != item_id)
                && match kind {
                    "sale" => related_sale_id.is_none() && next_item_id.is_none(),
                    "cancellation" => related_sale_id.is_some() && next_item_id.is_none() && !priced,
                    _ => next_item_id.is_some() && related_sale_id.is_none() && !priced,
                };
            let Some(occurred_at) = occurred_at.filter(|_| fits) else {
                return Err(format!(
                    "Check outcome row {}: use a UTC timestamp, quantity 1, an explicit review note and valid sale/cancellation/relist fields.",
                    index + 2
                ));
            };
            Ok(Reviewed {
                id,
                seller: seller.clone(),
                item_id,
                kind: kind.to_owned(),
                occurred_at,
                quantity: 1,
                price: priced.then(|| Amount {
                    amount: js_number::number(price_text),
                    currency: currency.to_owned(),
                }),
                related_sale_id,
                next_item_id,
                source: "reviewed-manual",
                note,
            })
        })
        .collect()
}

/// A price of whole units and at most two decimals (`/^\d+(?:\.\d{1,2})?$/`).
fn cents(text: &str) -> bool {
    let (whole, decimals) = text.split_once('.').unwrap_or((text, "1"));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (1..=2).contains(&decimals.len())
        && decimals.bytes().all(|b| b.is_ascii_digit())
}

/// A UTC time written `2026-10-02T03:04:05Z` or with milliseconds, that names a real moment, as
/// its ISO form with milliseconds.
fn utc_time(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    let shape = match b.len() {
        20 => b[19] == b'Z',
        24 => b[19] == b'.' && digits(20..23) && b[23] == b'Z',
        _ => false,
    } && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19);
    if !shape || &text[17..19] >= "60" {
        return None;
    }
    let parsed =
        NaiveDateTime::parse_from_str(&text[..text.len() - 1], "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    let iso = parsed
        .and_utc()
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let written = if b.len() == 20 {
        format!("{}.000Z", &text[..19])
    } else {
        text.to_owned()
    };
    (iso == written).then_some(iso)
}

/// `importSellerOutcomeCsv`: the reviewed outcomes saved for the seller's imported listings,
/// each claim once. A claim that contradicts one saved is saved beside it, for review.
pub async fn import(db: &Database, csv: &str, seller: &str) -> Result<Imported, String> {
    let mut conn = db.0.acquire().await.map_err(unavailable)?;
    record(&mut conn, csv, seller).await
}

fn unavailable(error: sqlx::Error) -> String {
    eprintln!("slab outcomes: {error}");
    "Seller outcomes are unavailable.".to_owned()
}

async fn record(conn: &mut PgConnection, csv: &str, seller: &str) -> Result<Imported, String> {
    use sqlx::Connection;
    let rows = parse(csv, seller)?;
    let seller = rows[0].seller.clone();
    let mut tx = conn.begin().await.map_err(unavailable)?;
    sqlx::query("SET LOCAL statement_timeout = '10s'")
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
    let later = |row: &Reviewed| {
        DateTime::parse_from_rfc3339(&row.occurred_at)
            .is_ok_and(|at| at.timestamp_millis() > now.timestamp_millis())
    };
    if rows.iter().any(later) {
        return Err("An outcome cannot occur in the future.".to_owned());
    }
    let mut item_ids: Vec<String> = Vec::new();
    for row in &rows {
        if !item_ids.contains(&row.item_id) {
            item_ids.push(row.item_id.clone());
        }
    }
    let owned: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT item_id FROM slab_inventory WHERE seller=$1 AND item_id=ANY($2::text[])",
    )
    .bind(&seller)
    .bind(&item_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(unavailable)?;
    if owned.len() != item_ids.len() {
        return Err(
            "Import each referenced listing into this seller's inventory first.".to_owned(),
        );
    }
    let entries: Vec<String> = rows
        .iter()
        .map(|row| {
            let payload = js_json(row);
            format!(
                "{{\"event_id\":{},\"item_id\":{},\"content_hash\":\"{}\",\"payload\":{payload}}}",
                js_json(&row.id),
                js_json(&row.item_id),
                sha256_hex(&payload)
            )
        })
        .collect();
    // Repeated imports keep when a claim was first observed.
    let inserted = sqlx::query(
        "INSERT INTO slab_seller_outcomes(seller,event_id,content_hash,item_id,payload)
         SELECT $1,x.event_id,x.content_hash,x.item_id,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(event_id text,content_hash text,item_id text,payload jsonb)
         ON CONFLICT DO NOTHING",
    )
    .bind(&seller)
    .bind(format!("[{}]", entries.join(",")))
    .execute(&mut *tx)
    .await
    .map_err(unavailable)?
    .rows_affected();
    tx.commit().await.map_err(unavailable)?;
    Ok(Imported {
        inserted: inserted as u32,
        supplied: rows.len() as u32,
        item_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `/api/slab-outcomes` import recorded over `.port-logs/slab-outcome-cases.json`
    /// (`slab-outcome-node.ts`), in order, on the listings `slab-inventory-seed.sql` and
    /// `slab-outcome-seed.sql` save, inside a transaction rolled back: each must answer as Node
    /// answered (its refusals were 400s with the message here) and leave the outcomes as Node did.
    #[tokio::test]
    #[ignore = "reads the dev database and .port-logs; writes only in a transaction that is rolled back"]
    async fn imports_as_node_imports() {
        use sqlx::Connection;
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read("slab-outcome-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("slab-outcome.node.json")).unwrap();
        let capture = read("slab-outcome-capture.sql");
        assert_eq!(cases.len(), node.len());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        for seed in ["slab-inventory-seed.sql", "slab-outcome-seed.sql"] {
            sqlx::raw_sql(&read(seed)).execute(&mut *tx).await.unwrap();
        }
        for (case, node) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let got = record(
                &mut tx,
                case["csv"].as_str().unwrap(),
                case["seller"].as_str().unwrap(),
            )
            .await;
            match node["body"]["error"].as_str() {
                None => {
                    let expected: Imported = serde_json::from_value(node["body"].clone()).unwrap();
                    assert_eq!(got.unwrap(), expected, "{name}");
                }
                Some(error) => assert_eq!(got.unwrap_err(), error, "{name}"),
            }
            let saved: Value = sqlx::query_scalar(&capture)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(saved, node["saved"], "{name}: saved");
        }
        tx.rollback().await.unwrap();
    }

    /// The cases in `.port-logs/seller-outcomes-cases.json` on the claims
    /// `seller-outcomes-seed.sql` saves, in a transaction rolled back, against Node's
    /// `readSellerOutcomes` (`.port-logs/seller-outcomes-node.ts`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn outcomes_read_as_node_reads_them() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            seller: String,
            item_id: String,
            as_of: String,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Case> =
            serde_json::from_str(&read_log("seller-outcomes-cases.json")).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log("seller-outcomes.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("seller-outcomes-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let shown = format!("{} {} as of {}", case.seller, case.item_id, case.as_of);
            let as_of = time(&case.as_of).unwrap();
            match review(&mut tx, &case.seller, &case.item_id, as_of).await {
                Err(error) => assert_eq!(Some(error.as_str()), theirs["error"].as_str(), "{shown}"),
                Ok(ours) => {
                    assert_eq!(ours.item_id, theirs["itemId"], "{shown}");
                    let summary: Summary =
                        serde_json::from_value(theirs["summary"].clone()).unwrap();
                    assert_eq!(ours.summary, summary, "{shown}");
                    let observed = theirs["observations"].as_array().unwrap();
                    let ids = |o: &Value| {
                        (
                            o["id"].as_str().unwrap().to_owned(),
                            o["observedAt"].as_str().unwrap().to_owned(),
                        )
                    };
                    let ours: Vec<(String, String)> = ours
                        .observations
                        .iter()
                        .map(|o| (o.id.clone(), o.observed_at.clone()))
                        .collect();
                    assert_eq!(
                        ours,
                        observed.iter().map(ids).collect::<Vec<_>>(),
                        "{shown}"
                    );
                }
            }
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn an_observation_reads_as_one_line() {
        let row: Observation = serde_json::from_value(serde_json::json!({
            "id": "e1", "seller": "pokebash", "itemId": "123456789", "quantity": 1, "kind": "sale", "occurredAt": "2026-09-01T12:00:00Z",
            "observedAt": "2026-09-02T00:00:00.000Z", "price": { "amount": 40, "currency": "USD" },
            "source": "reviewed-manual", "note": "invoice", "relatedSaleId": null, "nextItemId": "987654321"
        }))
        .unwrap();
        assert_eq!(
            row.line(),
            "e1 · listing 123456789 · sale · 2026-09-01T12:00:00Z · USD 40.00 · reviewed manual · first recorded 2026-09-02T00:00:00.000Z · invoice · relisted as 987654321"
        );
    }
}
