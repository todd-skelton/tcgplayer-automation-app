//! Reading eBay Research for a graded card: a page of sold listings (each an average of its sales)
//! or of active listings, found by keywords over a window of days, through the slab connection's
//! [`Transport`]. Ported from `evidence/ebayResearchProvider.server.ts` and
//! `evidence/ebayResearchStream.server.ts`.
//!
//! eBay answers a stream of JSON modules separated by blank lines. It is read strictly, as Node
//! reads it: anything unexpected is `invalid-response`, an error eBay reports is `unavailable`,
//! and an empty search is accepted only when eBay says so for these keywords.
use std::{future::Future, sync::LazyLock};

use chrono::{Days, NaiveDate, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use reqwest::Url;
use serde_json::{Map, Value, json};

use super::{
    alt::{MAX_SAFE_INTEGER, Read, invalid, js_length, js_trim, now, number, object},
    spec::Window,
};
use crate::features::slab_connections::{
    Ask, ConnectionStatus as Status, Gate, Provider, Transport,
};

/// What to search: keywords over a window of days, a page of results, in a time zone.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct Query {
    pub keywords: String,
    pub window: Window,
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "fifty")]
    pub limit: i64,
    #[serde(default = "chicago")]
    pub timezone: String,
}

fn fifty() -> i64 {
    50
}

fn chicago() -> String {
    "America/Chicago".into()
}

/// The two tabs of eBay Research.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Sold,
    Active,
}

/// `researchText`: a display's text, its spans joined, trimmed; none when absent or blank.
fn display(value: &Value) -> Read<Option<String>> {
    let row = match value {
        Value::Null => return Ok(None),
        Value::Object(row) => row,
        _ => return invalid(),
    };
    let text = match (row.get("value"), row.get("textSpans")) {
        (Some(Value::String(text)), _) => text.clone(),
        (_, Some(Value::Array(spans))) => {
            let mut text = String::new();
            for span in spans {
                match span {
                    Value::Array(_) => {}
                    Value::Object(span) => match span.get("text") {
                        None => {}
                        Some(Value::String(part)) => text.push_str(part),
                        Some(_) => return invalid(),
                    },
                    _ => return invalid(),
                }
            }
            text
        }
        _ => return invalid(),
    };
    let text = js_trim(&text);
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

fn get<'a>(row: &'a Map<String, Value>, name: &str) -> &'a Value {
    row.get(name).unwrap_or(&Value::Null)
}

static MONEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\+?\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(?: shipping)?$").expect("a regex")
});
static FREE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^free shipping$").expect("a regex"));
static COUNT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\d{1,3}(?:,\d{3})+|\d+)$").expect("a regex"));
static DAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("a regex"));
static HUMAN_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$")
        .expect("a regex")
});
static RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Results:\s*([\d,]+)\s*-\s*([\d,]+)$").expect("a regex"));
static ITEM_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{9,15}$").expect("a regex"));

/// A dollar amount eBay shows (`$1,234.50`); free shipping is nothing; none when not shown.
fn money(value: &Value, shipping: bool) -> Read<Value> {
    let Some(text) = display(value)?.filter(|t| t != "-") else {
        return Ok(Value::Null);
    };
    if shipping && FREE.is_match(&text) {
        return Ok(json!({ "amount": 0, "currency": "USD" }));
    }
    let Some(digits) = MONEY.captures(&text) else {
        return invalid();
    };
    let amount: f64 = digits[1]
        .replace(',', "")
        .parse()
        .map_err(|_| Status::InvalidResponse)?;
    if !amount.is_finite() || amount > MAX_SAFE_INTEGER / 100.0 {
        return invalid();
    }
    Ok(json!({ "amount": number(amount), "currency": "USD" }))
}

fn count(value: &Value) -> Read<Value> {
    let Some(text) = display(value)?.filter(|t| t != "-") else {
        return Ok(Value::Null);
    };
    if !COUNT.is_match(&text) {
        return invalid();
    }
    match text.replace(',', "").parse::<f64>() {
        Ok(n) if n <= MAX_SAFE_INTEGER => Ok(number(n)),
        _ => invalid(),
    }
}

/// A calendar date `YYYY-MM-DD`.
fn day(value: &str) -> Read<NaiveDate> {
    if !DAY.is_match(value) {
        return invalid();
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| Status::InvalidResponse)
}

/// A date as eBay shows it (`Sep 5, 2026`); none when not shown.
fn human_date(text: Option<&str>) -> Read<Option<String>> {
    let Some(text) = text.filter(|t| *t != "-") else {
        return Ok(None);
    };
    let Some(parts) = HUMAN_DATE.captures(text) else {
        return invalid();
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.iter().position(|m| *m == &parts[1]).unwrap_or(0) + 1;
    let iso = format!("{}-{month:02}-{:0>2}", &parts[3], &parts[2]);
    day(&iso).map(|_| Some(iso))
}

fn source_date(value: &Value) -> Read<Value> {
    Ok(human_date(display(value)?.as_deref())?.map_or(Value::Null, Value::String))
}

/// `researchMidnight`: when `date` begins in `zone`, in milliseconds, found as Node finds it.
pub fn midnight(date: NaiveDate, zone: Tz) -> Read<i64> {
    let target = date
        .and_hms_opt(0, 0, 0)
        .ok_or(Status::InvalidResponse)?
        .and_utc()
        .timestamp_millis();
    let mut guess = target;
    for _ in 0..3 {
        let shown = zone
            .timestamp_millis_opt(guess)
            .single()
            .ok_or(Status::InvalidResponse)?
            .naive_local()
            .and_utc()
            .timestamp()
            * 1000;
        if shown == target {
            return Ok(guess);
        }
        guess += target - shown;
    }
    invalid()
}

/// A query checked as Node checks it: its keywords trimmed.
struct Checked {
    keywords: String,
    from: NaiveDate,
    to: NaiveDate,
    offset: i64,
    limit: i64,
    zone: Tz,
}

fn check(query: &Query) -> Read<Checked> {
    let keywords = js_trim(&query.keywords).to_owned();
    let from = day(&query.window.from)?;
    let to = day(&query.window.to)?;
    let bounded = !keywords.is_empty()
        && js_length(&keywords) <= 500
        && !keywords.chars().any(|c| c < '\u{20}')
        && query.window.from <= query.window.to
        && [10, 20, 50].contains(&query.limit)
        && (0..=10_000).contains(&query.offset)
        && query.offset % query.limit == 0;
    if !bounded {
        return invalid();
    }
    let zone = Tz::from_str_insensitive(&query.timezone).map_err(|_| Status::InvalidResponse)?;
    Ok(Checked {
        keywords,
        from,
        to,
        offset: query.offset,
        limit: query.limit,
        zone,
    })
}

/// The search eBay Research is asked: the path and query string.
pub fn search_path(query: &Query, tab: Tab) -> Read<String> {
    let q = check(query)?;
    let next_day =
        q.to.checked_add_days(Days::new(1))
            .ok_or(Status::InvalidResponse)?;
    let days = (q.to - q.from).num_days().max(1);
    let mut url = Url::parse("https://www.ebay.com/sh/research/api/search").expect("a URL");
    url.query_pairs_mut()
        .append_pair("marketplace", "EBAY-US")
        .append_pair("keywords", &q.keywords)
        .append_pair("dayRange", &days.to_string())
        .append_pair("startDate", &midnight(q.from, q.zone)?.to_string())
        .append_pair("endDate", &(midnight(next_day, q.zone)? - 1).to_string())
        .append_pair("categoryId", "0")
        .append_pair("offset", &q.offset.to_string())
        .append_pair("limit", &q.limit.to_string())
        .append_pair("tabName", if tab == Tab::Sold { "SOLD" } else { "ACTIVE" })
        .append_pair("tz", &query.timezone)
        .append_pair("modules", "aggregates")
        .append_pair("modules", "searchResults")
        .append_pair("modules", "resultsHeader");
    Ok(format!(
        "{}?{}",
        url.path(),
        url.query().unwrap_or_default()
    ))
}

/// The JSON frames of eBay's answer, split at blank lines as Node's stream splits them.
fn frames(body: &str) -> Vec<&str> {
    let mut frames = Vec::new();
    let (mut start, mut pending, mut previous_cr) = (0, None, false);
    for (index, c) in body.char_indices() {
        if c == '\n' {
            match pending {
                None => pending = Some(index - usize::from(previous_cr)),
                Some(end) => {
                    frames.push(&body[start..end]);
                    start = index + 1;
                    pending = None;
                }
            }
        } else if !matches!(c, ' ' | '\t' | '\r') {
            pending = None;
        }
        previous_cr = c == '\r';
    }
    frames.push(&body[start..]);
    frames
}

const REQUIRED: [&str; 4] = [
    "ResultsHeaderModule",
    "ResearchAggregateModule",
    "SearchResultsModule",
    "ActiveSearchResultsModule",
];

/// The modules eBay answered, once each, and which tab it showed; `empty` when eBay said there
/// were no results for these keywords.
struct Stream {
    state: Tab,
    results: Map<String, Value>,
    aggregate: Map<String, Value>,
    header: Map<String, Value>,
    empty: bool,
}

fn is_blank_payload(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// `createResearchStream`: eBay's answer read module by module.
fn stream(body: &str, keywords: &str) -> Read<Stream> {
    let js_space = |c: char| c.is_whitespace() || c == '\u{feff}';
    if body.trim_start_matches(js_space).starts_with('<') {
        return Err(Status::ReconnectRequired);
    }
    let mut modules: Map<String, Value> = Map::new();
    let mut empty_state = None;
    let mut count = 0;
    for frame in frames(body) {
        if js_trim(frame).is_empty() {
            continue;
        }
        count += 1;
        if count > 16 {
            return invalid();
        }
        let module: Value = serde_json::from_str(frame).map_err(|_| Status::InvalidResponse)?;
        let Some(kind) = module
            .get("_type")
            .and_then(Value::as_str)
            .filter(|_| module.is_object())
        else {
            return invalid();
        };
        if kind == "PageErrorModule" {
            // eBay sends an error placeholder even with sold results: only one with content counts.
            let payload: Vec<(&String, &Value)> = object(&module)?
                .iter()
                .filter(|(key, _)| {
                    !matches!(key.as_str(), "_type" | "severity" | "meta" | "debugUrl")
                })
                .collect();
            if payload.iter().any(|(_, value)| !is_blank_payload(value)) {
                let message = match module.get("messages") {
                    Some(Value::Array(messages)) if messages.len() == 1 => messages[0].clone(),
                    _ => Value::Null,
                };
                let text = display(&message)?;
                let only_messages = payload.len() == 1 && payload[0].0 == "messages";
                let severity = module.get("severity").and_then(Value::as_str);
                let said = |tab: &str| {
                    !keywords.is_empty()
                        && only_messages
                        && text.as_deref()
                            == Some(format!("No {tab} results found for \"{keywords}\"").as_str())
                };
                if severity == Some("WARNING") && said("sold") {
                    empty_state = Some(Tab::Sold);
                } else if severity == Some("ERROR") && said("active") {
                    empty_state = Some(Tab::Active);
                } else {
                    return Err(Status::Unavailable);
                }
            }
        }
        if REQUIRED.contains(&kind) {
            if modules.contains_key(kind) {
                return invalid();
            }
            modules.insert(kind.to_owned(), module.clone());
        }
    }
    let header = modules
        .get("ResultsHeaderModule")
        .and_then(Value::as_object)
        .cloned();
    let aggregate = modules
        .get("ResearchAggregateModule")
        .and_then(Value::as_object)
        .cloned();
    let (Some(header), Some(mut aggregate)) = (header, aggregate) else {
        return invalid();
    };
    let Some(tabs) = header.get("tabs").and_then(Value::as_array) else {
        return invalid();
    };
    let selected: Vec<&Value> = tabs
        .iter()
        .filter(|tab| tab.is_object() && tab["active"] == true)
        .collect();
    let state = match selected.as_slice() {
        [tab] if tab["id"] == "sold" => Tab::Sold,
        [tab] if tab["id"] == "active" => Tab::Active,
        _ => return invalid(),
    };
    let (mine, other) = match state {
        Tab::Sold => ("SearchResultsModule", "ActiveSearchResultsModule"),
        Tab::Active => ("ActiveSearchResultsModule", "SearchResultsModule"),
    };
    let Some(mut results) = modules.get(mine).and_then(Value::as_object).cloned() else {
        return invalid();
    };
    let rows = results.get("results");
    let listed = rows.and_then(Value::as_array);
    if (empty_state.is_none() && listed.is_none())
        || listed.is_some_and(|rows| rows.len() > 50)
        || modules.contains_key(other)
    {
        return invalid();
    }
    let Some(empty) = empty_state else {
        return Ok(Stream {
            state,
            results,
            aggregate,
            header,
            empty: false,
        });
    };
    let sections = aggregate.get("sections");
    if state != empty
        || (rows.is_some() && listed.is_none_or(|l| !l.is_empty()))
        || (empty == Tab::Sold
            && sections.is_some_and(|s| s.as_array().is_none_or(|s| !s.is_empty())))
    {
        return invalid();
    }
    if empty == Tab::Active {
        let Some(sections) = sections.and_then(Value::as_array) else {
            return invalid();
        };
        let mut totals = Vec::new();
        for section in sections {
            for item in section
                .get("dataItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if display(item.get("header").unwrap_or(&Value::Null))?.as_deref()
                    == Some("Total active listings")
                {
                    totals.push(item);
                }
            }
        }
        if totals.len() != 1
            || display(totals[0].get("value").unwrap_or(&Value::Null))?.as_deref() != Some("0")
        {
            return invalid();
        }
    }
    results.insert("results".into(), json!([]));
    aggregate.entry("sections").or_insert_with(|| json!([]));
    Ok(Stream {
        state,
        results,
        aggregate,
        header,
        empty: true,
    })
}

/// A result's listing: its item number, title, and formats.
struct Listing<'a> {
    row: &'a Map<String, Value>,
    item_id: String,
    title: String,
    extended_title: Value,
    format: Option<String>,
    source_url: String,
}

fn listing(value: &Value) -> Read<Listing<'_>> {
    let row = object(value)?;
    let listing = object(get(row, "listing"))?;
    let item_id = display(get(listing, "itemId"))?;
    let title = display(get(listing, "title"))?;
    let (Some(item_id), Some(title)) = (item_id.filter(|id| ITEM_ID.is_match(id)), title) else {
        return invalid();
    };
    let format = match get(listing, "formatList") {
        Value::Array(formats) => {
            let mut shown = Vec::new();
            for format in formats {
                if let Some(text) = display(format)? {
                    shown.push(text);
                }
            }
            Some(shown.join(", ")).filter(|f| !f.is_empty())
        }
        _ => None,
    };
    Ok(Listing {
        row,
        source_url: format!("https://www.ebay.com/itm/{item_id}"),
        extended_title: display(get(listing, "extendedTitle"))?.map_or(Value::Null, Value::String),
        item_id,
        title,
        format,
    })
}

const UNKNOWN_GRADING: &str = r#"{"grader":"UNKNOWN","encoding":"unknown","number":null,"label":null,"qualifier":null,"autograph":null}"#;

/// A sold result: the average of the listing's sales, never expanded into sales.
fn sale(value: &Value) -> Read<Value> {
    let entry = listing(value)?;
    let price = object(get(entry.row, "avgsalesprice"))?;
    let shipping = match get(entry.row, "avgshipping") {
        Value::Null => Value::Null,
        shipping => get(object(shipping)?, "avgshipping").clone(),
    };
    let format = display(get(price, "format"))?.or(entry.format);
    Ok(json!({
        "provider": "ebayResearch",
        "providerId": entry.item_id,
        "assetId": null,
        "sourceItemId": entry.item_id,
        "sourceUrl": entry.source_url,
        "sourceReference": entry.source_url,
        "venue": "eBay",
        "kind": "listing-average",
        "date": source_date(get(entry.row, "datelastsold"))?,
        "format": format,
        "title": entry.title,
        "extendedTitle": entry.extended_title,
        "card": null,
        "grading": serde_json::from_str::<Value>(UNKNOWN_GRADING).expect("JSON"),
        "certificateNumber": null,
        "price": money(get(price, "avgsalesprice"), false)?,
        "convertedPrice": null,
        "shipping": money(&shipping, true)?,
        "fees": null,
        "shippingIncluded": false,
        "buyerPremiumIncluded": null,
        "quantity": count(get(entry.row, "itemssold"))?,
        "subjectToChange": null,
        "skippedReason": null,
    }))
}

/// An active result: a bid for an auction, an ask for a fixed price.
fn supply(value: &Value) -> Read<Value> {
    let entry = listing(value)?;
    let price = object(get(entry.row, "listingPrice"))?;
    let kind = match entry.format.as_deref().map(str::to_lowercase).as_deref() {
        Some("auction") => "bid",
        Some("fixed price" | "fixed price, best offer accepted") => "ask",
        _ => "unknown",
    };
    Ok(json!({
        "provider": "ebayResearch",
        "providerId": entry.item_id,
        "assetId": null,
        "venue": "eBay",
        "sourceUrl": entry.source_url,
        "title": entry.title,
        "extendedTitle": entry.extended_title,
        "format": entry.format,
        "state": "ACTIVE",
        "price": money(get(price, "listingPrice"), false)?,
        "priceKind": kind,
        "shipping": money(get(price, "listingShipping"), true)?,
        "quantity": null,
        "startedAt": source_date(get(entry.row, "startDate"))?,
        "endsAt": null,
        "items": [],
    }))
}

/// The summary eBay shows over the results.
fn summary(module: &Map<String, Value>) -> Read<Value> {
    let Some(sections) = get(module, "sections").as_array() else {
        return invalid();
    };
    let mut items = Vec::new();
    for section in sections {
        let Some(data_items) = get(object(section)?, "dataItems").as_array() else {
            return invalid();
        };
        for item in data_items {
            let item = object(item)?;
            let text =
                |name: &str| display(get(item, name)).map(|t| t.map_or(Value::Null, Value::String));
            items.push(json!({ "label": text("header")?, "value": text("value")?, "description": text("tooltip")? }));
        }
    }
    Ok(Value::Array(items))
}

fn whole(text: &str) -> Option<f64> {
    text.replace(',', "").parse().ok()
}

/// `pageInfo`: the page eBay showed is the one asked for, and whether another follows.
fn page(module: &Map<String, Value>, offset: i64, limit: i64) -> Read<Value> {
    let pagination = object(get(module, "pagination"))?;
    let Some(last) = get(object(get(pagination, "next"))?, "disabled").as_bool() else {
        return invalid();
    };
    if get(pagination, "currentPageNum").as_f64() != Some((offset / limit + 1) as f64) {
        return invalid();
    }
    let Some(sizes) = get(object(get(pagination, "itemsPerPage"))?, "options").as_array() else {
        return invalid();
    };
    let mut selected = Vec::new();
    for size in sizes {
        if get(object(size)?, "selected") == &Value::Bool(true) {
            selected.push(size);
        }
    }
    // eBay names the page size as text: the number 50 is not the selected "50".
    let size = limit.to_string();
    if selected.len() != 1 || selected[0]["value"].as_str() != Some(size.as_str()) {
        return invalid();
    }
    let rows = get(module, "results").as_array().map_or(0, Vec::len) as i64;
    if rows > limit || (!last && rows == 0) {
        return invalid();
    }
    let shown = display(get(pagination, "summary"))?;
    let range = shown.as_deref().and_then(|s| RANGE.captures(s));
    let fits = range.is_some_and(|r| {
        whole(&r[1]) == Some((offset + 1) as f64) && whole(&r[2]) == Some((offset + rows) as f64)
    });
    if !fits {
        return invalid();
    }
    Ok(json!({
        "offset": offset,
        "limit": limit,
        "nextOffset": if last { Value::Null } else { json!(offset + limit) },
        "partial": !last && rows < limit,
    }))
}

/// What eBay answered for `query` on `tab`, read as `getSalesPage` or `getSupplyPage` reads it.
pub fn read_page(body: &str, tab: Tab, query: &Query, as_of: &str) -> Read<Value> {
    let q = check(query)?;
    let stream = stream(body, &q.keywords)?;
    let page = if stream.empty {
        json!({ "offset": q.offset, "limit": q.limit, "nextOffset": null, "partial": false })
    } else {
        page(&stream.results, q.offset, q.limit)?
    };
    let summary = summary(&stream.aggregate)?;
    if stream.state == Tab::Sold {
        let shown = display(get(&stream.header, "dateRange"))?;
        let Some(shown) = shown else {
            return invalid();
        };
        let range = shown
            .split('\u{2013}')
            .map(|part| human_date(Some(js_trim(part))))
            .collect::<Read<Vec<_>>>()?;
        let asked = [
            Some(query.window.from.clone()),
            Some(query.window.to.clone()),
        ];
        if range != asked {
            return invalid();
        }
    }
    let rows = get(&stream.results, "results")
        .as_array()
        .cloned()
        .unwrap_or_default();
    let window = json!({ "from": q.from.format("%Y-%m-%d").to_string(), "to": q.to.format("%Y-%m-%d").to_string() });
    match (tab, stream.state) {
        (Tab::Sold, Tab::Sold) => {
            let sales = rows.iter().map(sale).collect::<Read<Vec<Value>>>()?;
            let mut dates: Vec<&str> = sales.iter().filter_map(|s| s["date"].as_str()).collect();
            dates.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let observed = match (dates.first(), dates.last()) {
                (Some(from), Some(to)) => json!({ "from": from, "to": to }),
                _ => Value::Null,
            };
            let source_count = sales.len();
            Ok(json!({
                "status": "sold",
                "sales": sales,
                "coverage": {
                    "requestedWindow": window,
                    "observedWindow": observed,
                    "complete": false,
                    "reason": "paged-search",
                    "sourceCount": source_count,
                    "limitPerGrade": null,
                },
                "asOf": as_of,
                "page": page,
                "summary": summary,
                "keywords": q.keywords,
            }))
        }
        (Tab::Sold, Tab::Active) => {
            // Node reads the rows before it sees the tab: a row it cannot read still fails.
            rows.iter().map(supply).collect::<Read<Vec<Value>>>()?;
            Ok(json!({ "status": "active-fallback", "asOf": as_of, "keywords": q.keywords }))
        }
        (Tab::Active, Tab::Active) => {
            let listings = rows.iter().map(supply).collect::<Read<Vec<Value>>>()?;
            Ok(json!({
                "status": "active",
                "listings": listings,
                "asOf": as_of,
                "page": page,
                "summary": summary,
                "scope": "ebay-search",
                "complete": false,
                "keywords": q.keywords,
            }))
        }
        (Tab::Active, Tab::Sold) => {
            rows.iter().map(sale).collect::<Read<Vec<Value>>>()?;
            invalid()
        }
    }
}

/// eBay Research through one connection: each read claims the connection, as every process's
/// reads do, and stops when `cancel` resolves. Node allows a run three reads; the worker makes
/// one per refresh, so this does not count them.
pub struct Ebay<'a, G> {
    pub transport: &'a Transport,
    pub gate: &'a G,
}

impl<G: Gate> Ebay<'_, G> {
    /// `getSalesPage` (`Tab::Sold`) or `getSupplyPage` (`Tab::Active`).
    pub async fn page(
        &self,
        query: &Query,
        tab: Tab,
        cancel: impl Future<Output = ()> + Send,
    ) -> Read<Value> {
        let path = search_path(query, tab)?;
        let as_of = now();
        let read = |body: &str| read_page(body, tab, query, &as_of);
        self.transport
            .request(
                self.gate,
                Provider::EbayResearch,
                Ask::get(path),
                read,
                cancel,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_at_blank_lines() {
        assert_eq!(frames("a\r\n\r\nb\n \t\n\nc"), ["a", "b", "\nc"]);
        assert_eq!(frames("a\nb"), ["a\nb"]);
    }

    /// Node's reader over the recorded fixtures and edge cases built from them
    /// (`.port-logs/ebay-parse-node.ts`): the search asked, and each answer or the status it
    /// refused with, are Node's.
    #[test]
    #[ignore = "reads .port-logs/ebay-parse.node.json, which Node writes"]
    fn answers_are_read_as_node_reads_them() {
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/ebay-parse.node.json").unwrap(),
        )
        .unwrap();
        let as_of = node["asOf"].as_str().unwrap();
        for case in node["results"].as_array().unwrap() {
            let query: Query = serde_json::from_value(case["query"].clone()).unwrap();
            let tab = if case["tab"] == "sales" {
                Tab::Sold
            } else {
                Tab::Active
            };
            let ours = match search_path(&query, tab) {
                Err(status) => json!({ "path": null, "error": status.as_ref() }),
                Ok(path) => match read_page(case["wire"].as_str().unwrap(), tab, &query, as_of) {
                    Ok(out) => json!({ "path": path, "out": out }),
                    Err(status) => json!({ "path": path, "error": status.as_ref() }),
                },
            };
            let theirs = match case.get("error") {
                Some(error) => json!({ "path": case["path"], "error": error }),
                None => json!({ "path": case["path"], "out": case["out"] }),
            };
            assert_eq!(ours, theirs, "{}", case["name"]);
        }
    }
}
