//! Reading Alt's evidence for a graded card: its recent sales at every grade, one sale's detail,
//! and its active listings, each from Alt's GraphQL API through the slab connection's
//! [`Transport`]. Ported from `evidence/altEvidenceProvider.server.ts` and
//! `identity/altIdentityFields.server.ts`.
//!
//! An answer is read strictly: anything this does not expect is `invalid-response`, an expired
//! session is `reconnect-required`. Prices keep Alt's own currency (unknown but for a sale's
//! detail), never converted.
use std::{future::Future, sync::LazyLock};

use chrono::{NaiveDate, SecondsFormat, Utc};
use regex::Regex;
use reqwest::Url;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::spec::Window;
use crate::features::{
    inventory_economics::ledger::fingerprint::{js_float, js_numbers},
    slab_connections::{Ask, ConnectionStatus as Status, Gate, Provider, Transport},
};

const TRANSACTIONS: &str =
    "query AssetMarketTransactions($id: ID!, $marketTransactionFilter: MarketTransactionFilter!) {
  asset(id: $id) { id marketTransactions(marketTransactionFilter: $marketTransactionFilter) {
    id date auctionHouse auctionType price label subjectToChange consolidatedSkippedReason
    attributes { gradeNumber gradingCompany url autograph }
  } }
}";
const DETAIL: &str = "query SoldListing($id: ID!) { externalTransaction(id: $id) {
  id date auctionHouse auctionName auctionType displayPrice label fees shipping usdAmount currency
  consolidatedSkippedReason subjectToChange
  asset { id name year subject category brand variety attributes { cardNumber } }
  attributes { grade gradingCompany cert url autograph }
} }";
const SUPPLY: &str = "query AssetDetails($id: ID!) { asset(id: $id) { id activeListings {
  id listPrice state createdAt type expiresAt
  items { id attributes { gradeNumber gradingCompany autograph qualifier } asset { id } }
} } }";
/// The most rows one answer may hold.
const MAX_ROWS: usize = 2000;
pub(super) const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(super) type Read<T> = Result<T, Status>;

pub(super) fn invalid<T>() -> Read<T> {
    Err(Status::InvalidResponse)
}

/// `String.prototype.trim`: JavaScript's white space and line terminators, which include the
/// byte order mark and not U+0085.
pub(super) fn js_trim(text: &str) -> &str {
    let space = |c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    };
    text.trim_matches(space)
}

/// A value's length as JavaScript counts it, in UTF-16 units.
pub(super) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn absent(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

pub(super) fn object(value: &Value) -> Read<&Map<String, Value>> {
    value.as_object().ok_or(Status::InvalidResponse)
}

/// An object, or none when the value is null or missing (`== null`).
fn object_or_empty(value: &Value) -> Read<Map<String, Value>> {
    if value.is_null() {
        Ok(Map::new())
    } else {
        object(value).cloned()
    }
}

/// Text of at most 2000 units, trimmed; none when absent or only space.
fn text(value: &Value) -> Read<Option<String>> {
    if absent(value) {
        return Ok(None);
    }
    match value.as_str() {
        Some(text) if js_length(text) <= 2000 => Ok(Some(js_trim(text))
            .filter(|t| !t.is_empty())
            .map(str::to_owned)),
        _ => invalid(),
    }
}

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-zA-Z0-9-]{1,80}$").expect("a regex"));

fn id(value: &Value) -> Read<String> {
    match text(value)? {
        Some(id) if ID.is_match(&id) => Ok(id),
        _ => invalid(),
    }
}

fn boolean(value: &Value) -> Read<Value> {
    match value {
        Value::Null | Value::Bool(_) => Ok(value.clone()),
        _ => invalid(),
    }
}

/// A number as JavaScript keeps it: a whole one without a fraction.
pub(super) fn number(value: f64) -> Value {
    js_numbers(&json!(value))
}

static DECIMAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+(?:\.\d+)?$").expect("a regex"));

/// An amount (a number, or decimal digits) in `currency`; none when absent.
fn money(value: &Value, currency: Option<&str>) -> Read<Value> {
    if absent(value) {
        return Ok(Value::Null);
    }
    let amount = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if DECIMAL.is_match(s) => s.parse::<f64>().ok(),
        _ => None,
    };
    match amount {
        Some(amount)
            if amount.is_finite() && (0.0..=MAX_SAFE_INTEGER / 100.0).contains(&amount) =>
        {
            Ok(json!({ "amount": number(amount), "currency": currency }))
        }
        _ => invalid(),
    }
}

static DAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("a regex"));

/// A calendar date `YYYY-MM-DD`; none when absent.
fn date(value: &Value) -> Read<Option<String>> {
    match text(value)? {
        None => Ok(None),
        Some(day) if DAY.is_match(&day) && NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_ok() => {
            Ok(Some(day))
        }
        Some(_) => invalid(),
    }
}

fn rows(value: &Value) -> Read<&Vec<Value>> {
    match value.as_array() {
        Some(rows) if rows.len() <= MAX_ROWS => Ok(rows),
        _ => invalid(),
    }
}

/// GraphQL's `data`, unless Alt answered an error: an unauthenticated one means the session
/// expired.
fn data(body: &str) -> Read<Map<String, Value>> {
    let answer: Value = serde_json::from_str(body).map_err(|_| Status::InvalidResponse)?;
    let answer = object(&answer)?;
    let errors = answer.get("errors");
    if let Some(Value::Array(errors)) = errors {
        for error in errors {
            let extensions = object(error)?.get("extensions").unwrap_or(&Value::Null);
            if object_or_empty(extensions)?
                .get("code")
                .and_then(Value::as_str)
                == Some("UNAUTHENTICATED")
            {
                return Err(Status::ReconnectRequired);
            }
        }
    }
    match errors {
        None => {}
        Some(Value::Array(errors)) if errors.is_empty() => {}
        Some(_) => return invalid(),
    }
    object(answer.get("data").unwrap_or(&Value::Null)).cloned()
}

static EBAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|\.)ebay\.com$").expect("a regex"));
static ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/itm/(?:[^/]+/)?(\d+)(?:/|$)").expect("a regex"));

/// The sale's page, when it is a plain web address, and its eBay item number.
fn source(value: &Value) -> Read<(Value, Value)> {
    let none = (Value::Null, Value::Null);
    let Some(raw) = text(value)? else {
        return Ok(none);
    };
    let Ok(url) = Url::parse(&raw) else {
        return Ok(none);
    };
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Ok(none);
    }
    let ebay = url.host_str().is_some_and(|host| EBAY.is_match(host));
    let item = if ebay {
        ITEM.captures(url.path())
            .map(|c| Value::String(c[1].to_owned()))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok((Value::String(url.to_string()), item))
}

/// `textField`: identity text of at most `max` units without control characters, trimmed.
fn field(value: &Value, max: usize) -> Read<Option<String>> {
    if absent(value) {
        return Ok(None);
    }
    match value.as_str() {
        Some(text) if js_length(text) <= max && !text.chars().any(|c| c < '\u{20}') => {
            Ok(Some(js_trim(text))
                .filter(|t| !t.is_empty())
                .map(str::to_owned))
        }
        _ => invalid(),
    }
}

fn nullable(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::String)
}

/// `altGrading`: the grader and Alt's grade as given; a number only for PSA's ordinary grades.
fn grading(attributes: &Map<String, Value>, label: &Value) -> Read<Value> {
    let get = |name: &str| attributes.get(name).unwrap_or(&Value::Null);
    let grader = field(get("gradingCompany"), 40)?
        .map(|g| g.to_uppercase())
        .unwrap_or_else(|| "UNKNOWN".into());
    let given = if get("gradeNumber").is_null() {
        get("grade")
    } else {
        get("gradeNumber")
    };
    let encoding = field(given, 40)?.unwrap_or_else(|| "unknown".into());
    let numeric = if DECIMAL.is_match(&encoding) {
        encoding.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    let psa = grader == "PSA"
        && (1.0..=10.0).contains(&numeric)
        && numeric != 9.5
        && (numeric * 2.0).fract() == 0.0;
    let label = match field(label, 200)? {
        Some(label) => Value::String(label),
        None if psa => Value::String(format!("PSA {}", js_float(numeric))),
        None => Value::Null,
    };
    Ok(json!({
        "grader": grader,
        "encoding": encoding,
        "number": if psa { number(numeric) } else { Value::Null },
        "label": label,
        "qualifier": nullable(field(get("qualifier"), 200)?),
        "autograph": nullable(field(get("autograph"), 200)?),
    }))
}

/// `altCard`: the card a sale's detail names.
fn card(asset: &Map<String, Value>) -> Read<Value> {
    let get = |name: &str| asset.get(name).unwrap_or(&Value::Null);
    let attributes = get("attributes");
    if !attributes.is_null() && !attributes.is_object() {
        return invalid();
    }
    let year = match get("year") {
        Value::Null => Value::Null,
        Value::Number(n) => match n.as_f64() {
            Some(y) if y.fract() == 0.0 && y.abs() <= MAX_SAFE_INTEGER => {
                Value::String((y as i64).to_string())
            }
            _ => return invalid(),
        },
        _ => return invalid(),
    };
    let name = if get("subject").is_null() {
        get("name")
    } else {
        get("subject")
    };
    let variety = get("variety");
    let edition = if variety == "1st Edition" {
        variety.clone()
    } else {
        Value::Null
    };
    let finish = match variety.as_str() {
        Some("Reverse Holo" | "Holo" | "Non-Holo") => variety.clone(),
        _ => Value::Null,
    };
    let game = if get("category") == "POKEMON_CARDS" {
        Value::from("Pokemon")
    } else {
        Value::Null
    };
    let mut card = Map::new();
    for (key, value) in [
        ("name", name),
        ("game", &game),
        ("language", &Value::Null),
        ("set", get("brand")),
        (
            "cardNumber",
            attributes.get("cardNumber").unwrap_or(&Value::Null),
        ),
        ("year", &year),
        ("edition", &edition),
        ("finish", &finish),
        ("stamp", &Value::Null),
    ] {
        card.insert(key.into(), nullable(field(value, 200)?));
    }
    if card["name"].is_null() {
        return invalid();
    }
    Ok(Value::Object(card))
}

/// A sale as evidence: a row of Alt's market transactions, or (`detail`) a sold listing.
fn sale(value: &Value, asset_id: &str, detail: bool) -> Read<Value> {
    let row = object(value)?;
    let get = |name: &str| row.get(name).unwrap_or(&Value::Null);
    let attributes = object_or_empty(get("attributes"))?;
    let attribute = |name: &str| attributes.get(name).unwrap_or(&Value::Null).clone();
    let currency = if detail {
        text(get("currency"))?.map(|c| c.to_uppercase())
    } else {
        None
    };
    if currency
        .as_deref()
        .is_some_and(|c| c.len() != 3 || !c.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return invalid();
    }
    let currency = currency.as_deref();
    let (source_url, source_item_id) = source(&attribute("url"))?;
    // Node reads these fields only for a detail, so a list row's are never refused.
    let only_detail = |read: &dyn Fn() -> Read<Value>| {
        if detail { read() } else { Ok(Value::Null) }
    };
    Ok(json!({
        "provider": "alt",
        "providerId": id(get("id"))?,
        "assetId": asset_id,
        "sourceUrl": source_url,
        "sourceItemId": source_item_id,
        "sourceReference": nullable(text(&attribute("url"))?),
        "venue": nullable(text(get("auctionHouse"))?),
        "kind": "transaction",
        "date": nullable(date(get("date"))?),
        "format": nullable(text(get("auctionType"))?),
        "title": only_detail(&|| text(get("auctionName")).map(nullable))?,
        "card": null,
        "grading": grading(&attributes, get("label"))?,
        "certificateNumber": only_detail(&|| text(&attribute("cert")).map(nullable))?,
        "price": money(get(if detail { "displayPrice" } else { "price" }), currency)?,
        "convertedPrice": only_detail(&|| money(get("usdAmount"), Some("USD")))?,
        "shipping": only_detail(&|| money(get("shipping"), currency))?,
        "fees": only_detail(&|| money(get("fees"), currency))?,
        "shippingIncluded": null,
        "buyerPremiumIncluded": null,
        "quantity": null,
        "subjectToChange": boolean(get("subjectToChange"))?,
        "skippedReason": nullable(text(get("consolidatedSkippedReason"))?),
    }))
}

fn asset<'a>(data: &'a Map<String, Value>, asset_id: &str) -> Read<&'a Map<String, Value>> {
    let asset = object(data.get("asset").unwrap_or(&Value::Null))?;
    if asset.get("id").and_then(Value::as_str) != Some(asset_id) {
        return invalid();
    }
    Ok(asset)
}

/// `parseAltSales`: the asset's sales in `window` (and those without a date), with what Alt
/// returned before the window was applied.
pub fn parse_sales(
    body: &str,
    asset_id: &str,
    window: &Window,
    limit_per_grade: u32,
    as_of: &str,
) -> Read<Value> {
    let data = data(body)?;
    let asset = asset(&data, asset_id)?;
    let observations = rows(asset.get("marketTransactions").unwrap_or(&Value::Null))?
        .iter()
        .map(|row| sale(row, asset_id, false))
        .collect::<Read<Vec<Value>>>()?;
    let mut dates: Vec<&str> = observations
        .iter()
        .filter_map(|row| row["date"].as_str())
        .collect();
    dates.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let observed = match (dates.first(), dates.last()) {
        (Some(from), Some(to)) => json!({ "from": from, "to": to }),
        _ => Value::Null,
    };
    let source_count = observations.len();
    // Sales without a date stay reviewable but cannot show what the window covers.
    let sales: Vec<Value> = observations
        .into_iter()
        .filter(|row| match row["date"].as_str() {
            None => true,
            Some(day) => day >= window.from.as_str() && day <= window.to.as_str(),
        })
        .collect();
    Ok(json!({
        "sales": sales,
        "asOf": as_of,
        "coverage": {
            "requestedWindow": { "from": window.from, "to": window.to },
            "observedWindow": observed,
            "complete": false,
            "reason": "capped-per-grade",
            "sourceCount": source_count,
            "limitPerGrade": limit_per_grade,
        },
    }))
}

/// `parseAltSaleDetail`: one sold listing with the card it names; null when Alt has none.
pub fn parse_sale_detail(body: &str, transaction_id: &str) -> Read<Value> {
    let data = data(body)?;
    let row = match data.get("externalTransaction") {
        Some(Value::Null) => return Ok(Value::Null),
        Some(row) => object(row)?,
        None => return invalid(),
    };
    if row.get("id").and_then(Value::as_str) != Some(transaction_id) {
        return invalid();
    }
    let asset = object(row.get("asset").unwrap_or(&Value::Null))?;
    let mut sale = sale(
        &Value::Object(row.clone()),
        &id(asset.get("id").unwrap_or(&Value::Null))?,
        true,
    )?;
    sale["card"] = card(asset)?;
    Ok(sale)
}

/// `parseAltSupply`: the asset's active listings, each with the slabs it sells.
pub fn parse_supply(body: &str, asset_id: &str) -> Read<Value> {
    let data = data(body)?;
    let asset = asset(&data, asset_id)?;
    rows(asset.get("activeListings").unwrap_or(&Value::Null))?
        .iter()
        .map(|value| {
            let row = object(value)?;
            let get = |name: &str| row.get(name).unwrap_or(&Value::Null);
            let items = rows(get("items"))?
                .iter()
                .map(|value| {
                    let item = object(value)?;
                    let item_asset = match item.get("asset").unwrap_or(&Value::Null) {
                        Value::Null => Value::Null,
                        asset => Value::String(id(object(asset)?.get("id").unwrap_or(&Value::Null))?),
                    };
                    let attributes = object_or_empty(item.get("attributes").unwrap_or(&Value::Null))?;
                    Ok(json!({ "assetId": item_asset, "grading": grading(&attributes, &Value::Null)? }))
                })
                .collect::<Read<Vec<Value>>>()?;
            Ok(json!({
                "provider": "alt",
                "providerId": id(get("id"))?,
                "assetId": asset_id,
                "venue": "Alt",
                "sourceUrl": null,
                "format": nullable(text(get("type"))?),
                "state": nullable(text(get("state"))?),
                "price": money(get("listPrice"), None)?,
                "priceKind": "unknown",
                "shipping": null,
                "quantity": null,
                "startedAt": nullable(text(get("createdAt"))?),
                "endsAt": nullable(text(get("expiresAt"))?),
                "items": items,
            }))
        })
        .collect::<Read<Vec<Value>>>()
        .map(Value::Array)
}

/// Alt's evidence through one connection: each read claims the connection, as every process's
/// reads do, and stops when `cancel` resolves.
pub struct Alt<'a, G> {
    pub transport: &'a Transport,
    pub gate: &'a G,
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation<'a> {
    operation_name: &'a str,
    variables: Value,
    query: &'a str,
}

impl<G: Gate> Alt<'_, G> {
    async fn read<T: Send>(
        &self,
        operation: &str,
        query: &str,
        variables: Value,
        parse: impl Fn(&str) -> Read<T> + Send + Sync,
        cancel: impl Future<Output = ()> + Send,
    ) -> Read<T> {
        let body = serde_json::to_string(&Operation {
            operation_name: operation,
            variables,
            query,
        })
        .map_err(|_| Status::InvalidResponse)?;
        let ask = Ask::post(format!("/graphql/{operation}"), body);
        self.transport
            .request(self.gate, Provider::Alt, ask, parse, cancel)
            .await
    }

    /// `getSales`: the asset's sales at every grade, at most `limit_per_grade` (1 to 16) each,
    /// with skipped ones, in `window`.
    pub async fn sales(
        &self,
        asset_id: &str,
        window: &Window,
        limit_per_grade: u32,
        cancel: impl Future<Output = ()> + Send,
    ) -> Read<Value> {
        let asset_id = id(&Value::from(asset_id))?;
        let from = date(&Value::from(window.from.as_str()))?;
        let to = date(&Value::from(window.to.as_str()))?;
        let window = match (from, to) {
            (Some(from), Some(to)) if from <= to && (1..=16).contains(&limit_per_grade) => {
                Window { from, to }
            }
            _ => return invalid(),
        };
        let as_of = now();
        let variables = json!({
            "id": asset_id,
            "marketTransactionFilter": {
                "allGrades": true, "showSkipped": true, "maxTransactionsPerGrade": limit_per_grade
            },
        });
        let parse = |body: &str| parse_sales(body, &asset_id, &window, limit_per_grade, &as_of);
        self.read(
            "AssetMarketTransactions",
            TRANSACTIONS,
            variables,
            parse,
            cancel,
        )
        .await
    }

    /// `getSaleDetail`: one sale's listing, or null when Alt has none. Node keeps a run's
    /// details (at most 32) to read each once; the worker reads one per refresh, so this does not.
    pub async fn sale_detail(
        &self,
        transaction_id: &str,
        cancel: impl Future<Output = ()> + Send,
    ) -> Read<Value> {
        let transaction_id = id(&Value::from(transaction_id))?;
        let parse = |body: &str| parse_sale_detail(body, &transaction_id);
        self.read(
            "SoldListing",
            DETAIL,
            json!({ "id": transaction_id }),
            parse,
            cancel,
        )
        .await
    }

    /// `getSupply`: the asset's active listings, Alt's only.
    pub async fn supply(
        &self,
        asset_id: &str,
        cancel: impl Future<Output = ()> + Send,
    ) -> Read<Value> {
        let asset_id = id(&Value::from(asset_id))?;
        let as_of = now();
        let parse = |body: &str| parse_supply(body, &asset_id);
        let listings = self
            .read(
                "AssetDetails",
                SUPPLY,
                json!({ "id": asset_id }),
                parse,
                cancel,
            )
            .await?;
        Ok(json!({ "listings": listings, "asOf": as_of, "scope": "alt-only", "complete": false }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use corten::axum::{Router, extract::Json};

    use super::*;
    use crate::features::slab_connections::Lease;

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

    /// Alt on this machine: it answers the recorded fixture for each operation and keeps what it
    /// was asked.
    async fn stand_in() -> (Transport, Arc<Mutex<Vec<Value>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        let app = Router::new().fallback(move |Json(operation): Json<Value>| {
            let kept = kept.clone();
            async move {
                let fixture = match operation["operationName"].as_str() {
                    Some("SoldListing") => "alt-sale-detail.json",
                    Some("AssetDetails") => {
                        let id = operation["variables"]["id"].clone();
                        kept.lock().unwrap().push(operation);
                        return json!({ "data": { "asset": { "id": id, "activeListings": [] } } })
                            .to_string();
                    }
                    _ => "alt-sales.json",
                };
                kept.lock().unwrap().push(operation);
                std::fs::read_to_string(format!(
                    "app/features/ebay-slab-pricing/evidence/fixtures/{fixture}"
                ))
                .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { corten::axum::serve(listener, app).await });
        (Transport::to(&origin, &origin), asked)
    }

    #[tokio::test]
    async fn reads_ask_alt_as_node_asks_it() {
        let (transport, asked) = stand_in().await;
        let alt = Alt {
            transport: &transport,
            gate: &Open,
        };
        let window = Window {
            from: "2020-01-01".into(),
            to: "2026-09-05".into(),
        };
        let asset = "cd3ecabf-7d43-4375-9428-1a7cdfe66426";
        let sales = alt
            .sales(asset, &window, 16, std::future::pending())
            .await
            .unwrap();
        assert_eq!(sales["coverage"]["sourceCount"], 4);
        let filter = asked.lock().unwrap()[0]["variables"]["marketTransactionFilter"].clone();
        assert_eq!(
            filter,
            json!({ "allGrades": true, "showSkipped": true, "maxTransactionsPerGrade": 16 })
        );
        let bad = Window {
            from: "2026-02-30".into(),
            to: "2026-09-05".into(),
        };
        assert_eq!(
            alt.sales(asset, &bad, 16, std::future::pending()).await,
            Err(Status::InvalidResponse)
        );
        let detail = alt
            .sale_detail(
                " 11020cc4-2783-494b-86b8-7d90c3ecc298 ",
                std::future::pending(),
            )
            .await
            .unwrap();
        assert_eq!(detail["card"]["edition"], "1st Edition");
        assert_eq!(detail["sourceItemId"], "335037487554");
        let supply = alt.supply(asset, std::future::pending()).await.unwrap();
        assert_eq!(supply["listings"], json!([]));
        assert_eq!(supply["scope"], "alt-only");
        assert_eq!(asked.lock().unwrap().len(), 3);
    }

    /// Node's parsers over the recorded fixtures and edge cases built from them
    /// (`.port-logs/alt-parse-node.ts`): each answer, or the status it refused with, is Node's.
    #[test]
    #[ignore = "reads .port-logs/alt-parse.node.json, which Node writes"]
    fn answers_are_read_as_node_reads_them() {
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/alt-parse.node.json").unwrap(),
        )
        .unwrap();
        let asset_id = node["assetId"].as_str().unwrap();
        let detail_id = node["detailId"].as_str().unwrap();
        let as_of = node["asOf"].as_str().unwrap();
        for case in node["results"].as_array().unwrap() {
            let body = case["body"].as_str().unwrap();
            let read = match case["kind"].as_str().unwrap() {
                "sales" => {
                    let window: Window = serde_json::from_value(case["args"][0].clone()).unwrap();
                    let limit = case["args"][1].as_u64().unwrap() as u32;
                    parse_sales(body, asset_id, &window, limit, as_of)
                }
                "detail" => parse_sale_detail(body, detail_id),
                _ => parse_supply(body, asset_id),
            };
            let ours = match read {
                Ok(out) => json!({ "out": out }),
                Err(status) => json!({ "error": status.as_ref() }),
            };
            let theirs = match case.get("error") {
                Some(error) => json!({ "error": error }),
                None => json!({ "out": case.get("out").cloned().unwrap_or(Value::Null) }),
            };
            assert_eq!(ours, theirs, "{}", case["name"]);
        }
    }
}
