//! An order export imported into the seller's order history, ported from
//! `sellerOrderFileImport.server.ts` (`parseSellerOrderCsv`, `importSellerOrderCsv`) and
//! `importObservations`: the file read as Papa Parse reads it, its rows grouped into orders, each
//! recorded as a revision when it changed. A file is imported once, by its content; an order the
//! API last described is left as the API said it.
use std::collections::HashMap;

use regex::Regex;
use serde_json::{Map, Value};
use sqlx::{Connection, PgConnection};

use super::{
    observation::{self, Line, Observation, Source, Transaction},
    store,
};
use crate::{
    csv_text::{self, Reading},
    features::inventory_economics::ledger::fingerprint::sha256_hex,
    js_number,
};

/// The largest file imported, 5 MB.
pub const MOST_BYTES: usize = 5 * 1024 * 1024;

/// The most rows a file may have.
const MOST_ROWS: usize = 50_000;

const REQUIRED: [&str; 6] = [
    "Order Number",
    "Order Time",
    "Status",
    "SKU ID",
    "Quantity",
    "Gross Item Proceeds USD",
];

/// The largest whole number JavaScript counts exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A row's fields by column.
type Row = Map<String, Value>;

/// `row[column]?.trim()`.
fn cell<'a>(row: &'a Row, column: &str) -> Option<&'a str> {
    row.get(column).and_then(Value::as_str).map(js_number::trim)
}

/// `row[column]?.trim() || undefined`.
fn optional(row: &Row, column: &str) -> Option<String> {
    cell(row, column)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn required(row: &Row, column: &str, row_number: usize) -> Result<String, String> {
    optional(row, column).ok_or_else(|| format!("Row {row_number}: {column} is required."))
}

/// JavaScript's `Math.round`: the nearest whole number, halves up.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Math.round(value * 100) / 100`, with no negative zero.
fn round_cents(value: f64) -> f64 {
    js_round(value * 100.0) / 100.0 + 0.0
}

/// `parseOffsetTimestamp`: a time ending in `Z` or a `±hh:mm` offset, as `toISOString` writes it.
/// `Date.parse` is read as its ISO form, with a space allowed for the `T` and the seconds left
/// out; a form only V8's legacy parser takes is refused.
fn timestamp(value: &str, label: &str) -> Result<String, String> {
    let refused = || format!("{label} must be an ISO timestamp with Z or a numeric UTC offset.");
    let iso = Regex::new(
        r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$",
    )
    .expect("the pattern is valid");
    let parts = iso.captures(value).ok_or_else(refused)?;
    let seconds = parts.get(3).map_or(":00", |s| s.as_str());
    let zone = match &parts[4] {
        "z" | "Z" => "Z",
        offset => offset,
    };
    let written = format!("{}T{}{seconds}{zone}", &parts[1], &parts[2]);
    chrono::DateTime::parse_from_rfc3339(&written)
        .map(|at| {
            at.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|_| refused())
}

/// `parsePositiveInteger`: `Number(value)`, a whole number above zero.
fn positive_integer(value: &str, label: &str) -> Result<f64, String> {
    let number = js_number::number(value);
    if number.fract() != 0.0 || number <= 0.0 || !number.is_finite() {
        return Err(format!("{label} must be a positive integer."));
    }
    Ok(number)
}

/// `parseMoney`: US dollars with at most two decimals.
fn money(value: &str, label: &str, allow_negative: bool) -> Result<f64, String> {
    let shaped = Regex::new(r"^-?\d+(?:\.\d{1,2})?$").expect("the pattern is valid");
    if !shaped.is_match(value) {
        return Err(format!(
            "{label} must be a USD amount with at most two decimal places."
        ));
    }
    let cents = js_round(js_number::number(value) * 100.0);
    if cents.abs() > MAX_SAFE_INTEGER {
        return Err(format!("{label} is outside the supported range."));
    }
    if !allow_negative && cents < 0.0 {
        return Err(format!("{label} cannot be negative."));
    }
    Ok(cents / 100.0 + 0.0)
}

/// `refundFromRow`: the refund a row names, or none when it names none.
fn refund(row: &Row, row_number: usize) -> Result<Option<Value>, String> {
    let kind = optional(row, "Refund Type");
    let created_at = optional(row, "Refund Created At");
    let amount = optional(row, "Refund Amount USD");
    let origin = optional(row, "Refund Origin");
    if kind.is_none() && created_at.is_none() && amount.is_none() && origin.is_none() {
        return Ok(None);
    }
    let mut refund = Map::new();
    if let Some(kind) = kind {
        refund.insert("type".into(), kind.into());
    }
    if let Some(at) = created_at {
        let label = format!("Row {row_number}: Refund Created At");
        refund.insert("createdAt".into(), timestamp(&at, &label)?.into());
    }
    if let Some(amount) = amount {
        let label = format!("Row {row_number}: Refund Amount USD");
        refund.insert("amount".into(), money(&amount, &label, true)?.into());
    }
    if let Some(origin) = origin {
        refund.insert("origin".into(), origin.into());
    }
    Ok(Some(Value::Object(refund)))
}

/// An order as its first row describes it, with the lines and refunds of all its rows.
struct Order {
    number: String,
    order_time: String,
    status: String,
    summary_order_time: Option<String>,
    order_channel: Option<String>,
    order_fulfillment: Option<String>,
    refund_status: Option<String>,
    lines: Vec<Line>,
    refunds: Vec<Value>,
}

impl Order {
    /// Whether another row describes the order as this one does.
    fn agrees(&self, other: &Order) -> bool {
        self.order_time == other.order_time
            && self.status == other.status
            && self.summary_order_time == other.summary_order_time
            && self.order_channel == other.order_channel
            && self.order_fulfillment == other.order_fulfillment
            && self.refund_status == other.refund_status
    }
}

/// One row read: the order it describes, its line and the refund it names.
fn row_order(row: &Row, row_number: usize) -> Result<(Order, Option<Value>), String> {
    let number = required(row, "Order Number", row_number)?;
    let order_time = timestamp(
        &required(row, "Order Time", row_number)?,
        &format!("Row {row_number}: Order Time"),
    )?;
    let status = required(row, "Status", row_number)?;
    let sku_id = required(row, "SKU ID", row_number)?;
    let quantity = positive_integer(
        &required(row, "Quantity", row_number)?,
        &format!("Row {row_number}: Quantity"),
    )?;
    let proceeds = money(
        &required(row, "Gross Item Proceeds USD", row_number)?,
        &format!("Row {row_number}: Gross Item Proceeds USD"),
        false,
    )?;
    if optional(row, "Currency").is_some_and(|currency| currency != "USD") {
        return Err(format!("Row {row_number}: Currency must be USD."));
    }
    let summary_order_time = optional(row, "Summary Order Time")
        .map(|at| timestamp(&at, &format!("Row {row_number}: Summary Order Time")))
        .transpose()?;
    let line = Line {
        name: cell(row, "Product Name").unwrap_or("").to_owned(),
        unit_price: round_cents(proceeds / quantity),
        extended_price: proceeds,
        quantity,
        product_id: cell(row, "Product ID").unwrap_or("").to_owned(),
        sku_id,
    };
    let order = Order {
        number,
        order_time,
        status,
        summary_order_time,
        order_channel: optional(row, "Order Channel"),
        order_fulfillment: optional(row, "Order Fulfillment"),
        refund_status: optional(row, "Refund Status"),
        lines: vec![line],
        refunds: Vec::new(),
    };
    Ok((order, refund(row, row_number)?))
}

/// `parseSellerOrderCsv`: the orders an export describes, in the order it first names them, as
/// observed at `observed_at`; or the first thing wrong with it, naming its row.
pub fn parse(seller_key: &str, text: &str, observed_at: &str) -> Result<Vec<Observation>, String> {
    let seller_key = seller_key.trim();
    if seller_key.is_empty() {
        return Err("Seller key is required.".into());
    }
    if text.len() > MOST_BYTES {
        return Err("Seller order CSV exceeds the 5 MB limit.".into());
    }
    let table = csv_text::read(
        text,
        Reading {
            greedy: true,
            trim_header: true,
        },
    );
    if let Some(why) = table.error {
        return Err(format!("CSV could not be parsed: {why}"));
    }
    if table.rows.len() > MOST_ROWS {
        return Err(format!(
            "Seller order CSV exceeds the {MOST_ROWS} row limit."
        ));
    }
    if let Some(missing) = REQUIRED
        .iter()
        .find(|c| !table.fields.iter().any(|f| f == *c))
    {
        return Err(format!("CSV is missing required column: {missing}."));
    }
    let mut orders: Vec<Order> = Vec::new();
    let mut by_number: HashMap<String, usize> = HashMap::new();
    for (index, row) in table.rows.iter().enumerate() {
        let (read, refund) = row_order(row, index + 2)?;
        let at = match by_number.get(&read.number) {
            Some(&at) => {
                if !orders[at].agrees(&read) {
                    return Err(format!(
                        "Rows for order {} disagree on order-level fields.",
                        read.number
                    ));
                }
                orders[at].lines.extend(read.lines);
                at
            }
            None => {
                by_number.insert(read.number.clone(), orders.len());
                orders.push(read);
                orders.len() - 1
            }
        };
        if let Some(refund) = refund
            && !orders[at].refunds.contains(&refund)
        {
            orders[at].refunds.push(refund);
        }
    }
    orders
        .into_iter()
        .map(|order| {
            let gross = order
                .lines
                .iter()
                .fold(0.0, |sum, l| sum + l.extended_price);
            let mut observation = Observation {
                seller_key: seller_key.to_owned(),
                order_number: order.number,
                order_time: order.order_time,
                summary_order_time: order.summary_order_time,
                lifecycle: observation::lifecycle(&order.status),
                provider_status: order.status,
                refund_status: order.refund_status.map(Value::from),
                order_channel: order.order_channel.map(Value::from),
                order_fulfillment: order.order_fulfillment.map(Value::from),
                gross_item_proceeds: round_cents(gross),
                transaction: Transaction::Absent,
                lines: order.lines,
                refunds: order.refunds,
                observed_at: observed_at.to_owned(),
                fingerprint: String::new(),
                summary_fingerprint: None,
                source: Source::FileImport,
            };
            observation.fingerprint = observation::fingerprint(&observation)?;
            Ok(observation)
        })
        .collect()
}

/// What an import did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// Orders it added or changed.
    pub imported_orders: usize,
    /// Orders the history already had as the file has them, or that the API last described.
    pub skipped_orders: usize,
    pub total_orders: usize,
    /// Whether the same file was imported before, so nothing was.
    pub duplicate_file: bool,
}

/// An export imported for `named` (else the default shipping seller, as the Node route resolves
/// it), observed now: the seller it was for and what it did.
pub async fn requested(
    db: &crate::database::Database,
    named: &str,
    file_name: Option<&str>,
    text: &str,
) -> Result<(String, Imported), String> {
    let failed = |e: sqlx::Error| e.to_string();
    let seller = match named.trim() {
        "" => crate::features::shipping_configuration::default_seller_key(db)
            .await
            .map_err(failed)?
            .trim()
            .to_owned(),
        named => named.to_owned(),
    };
    if seller.is_empty() {
        return Err("A seller key is required.".to_owned());
    }
    let observed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut conn = db.0.acquire().await.map_err(failed)?;
    let imported = import(&mut conn, &seller, text, file_name, &observed_at).await?;
    Ok((seller, imported))
}

/// `importSellerOrderCsv` on `conn`: the file's orders recorded for the seller, in a transaction
/// of their own (a savepoint when `conn` is in one), unless the same file was imported before.
pub async fn import(
    conn: &mut PgConnection,
    seller_key: &str,
    text: &str,
    file_name: Option<&str>,
    observed_at: &str,
) -> Result<Imported, String> {
    let failed = |e: sqlx::Error| e.to_string();
    if js_number::trim(text).is_empty() {
        return Err("A seller order CSV file is required.".into());
    }
    let fingerprint = sha256_hex(text);
    let observations = parse(seller_key, text, observed_at)?;
    let lines: usize = observations.iter().map(|o| o.lines.len()).sum();
    let mut tx = conn.begin().await.map_err(failed)?;
    let claimed: Option<String> = sqlx::query_scalar(
        "INSERT INTO seller_order_imports (seller_key, content_fingerprint, file_name, order_count, line_count)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id::text",
    )
    .bind(seller_key.trim())
    .bind(&fingerprint)
    .bind(file_name)
    .bind(observations.len() as i32)
    .bind(lines as i32)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let mut imported_orders = 0;
    if claimed.is_some() {
        for observation in &observations {
            if store::record_observation(&mut tx, observation).await?.0 {
                imported_orders += 1;
            }
        }
    }
    tx.commit().await.map_err(failed)?;
    Ok(Imported {
        imported_orders,
        skipped_orders: observations.len() - imported_orders,
        total_orders: observations.len(),
        duplicate_file: claimed.is_none(),
    })
}
