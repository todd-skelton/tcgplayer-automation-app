//! An operator's corrections to the FIFO matching, ported from `inventoryFifoRepository`: a
//! disposition (stock a canceled order released, or a physical restock) with the receipts it came
//! from (`recordDisposition`), a later order revision that accounts for a disposition
//! (`supersedeDisposition`), and a quantity the order lost after it was matched
//! (`recordQuantityCorrection`). Each claims the held SKU, records what it was told, and queues the
//! SKU for replay. A request sent again with the same id answers the first one's record.
//!
//! Each runs on a connection in the caller's transaction. Its refusals are Node's, as
//! `String(error)` writes them: `Error: ...` for the app's, `error: ...` for the database's.
//!
//! One difference: Node compares a repeated request's source allocations by their
//! `JSON.stringify`, so the same allocation written with its keys in another order conflicted.
//! The request is read here without its key order, so an allocation is the same one when its
//! `supplyKey`, `receiptId` and `quantity` are, whatever their order.
use std::cmp::Ordering;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

use super::{
    queue::{enqueue, standard_sku},
    replay::iso,
};
use crate::{
    features::inventory_economics::ledger::fingerprint::{js_float, js_numbers, stable_json},
    node_pg,
};

/// A disposition the operator records.
#[derive(Clone, Debug)]
pub struct Disposition {
    pub request_id: String,
    pub seller_key: String,
    pub order_number: String,
    pub sku_id: String,
    /// `unfulfilled_cancellation` or `physical_restock`.
    pub disposition_type: String,
    pub quantity: f64,
    pub source_order_revision: f64,
    pub available_at: DateTime<Utc>,
    pub evidence: Map<String, Value>,
    /// Each `{supplyKey, receiptId, quantity}`, as sent.
    pub source_allocations: Vec<Value>,
}

/// A later order revision that accounts for a disposition.
#[derive(Clone, Debug)]
pub struct Supersession {
    pub request_id: String,
    pub seller_key: String,
    pub disposition_id: String,
    pub source_order_revision: f64,
    pub confirmed_at: DateTime<Utc>,
    pub evidence: Map<String, Value>,
}

/// A quantity the order lost after it was matched.
#[derive(Clone, Debug)]
pub struct QuantityCorrection {
    pub request_id: String,
    pub seller_key: String,
    pub order_number: String,
    pub sku_id: String,
    pub source_order_revision: f64,
    pub available_at: DateTime<Utc>,
    pub evidence: Map<String, Value>,
    pub source_allocations: Vec<Value>,
}

/// What a correction answers: its record's id, and whether this request repeated one recorded.
pub fn recorded(id: String, repeated: bool) -> Value {
    json!({ "id": id, "repeated": repeated })
}

fn refused<T>(message: &str) -> Result<T, String> {
    Err(format!("Error: {message}"))
}

/// A time as node-pg hands it to Node: a `Date`, to the millisecond.
fn ms(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(at.timestamp_millis()).unwrap_or(at)
}

/// A whole number a request sent, as `Number.isInteger` reads it.
fn is_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.fract() == 0.0)
}

/// `value.supplyKey` of each allocation, refused as Node's `map` threw on a `null` one.
fn supply_keys(allocations: &[Value]) -> Result<Vec<Option<&Value>>, String> {
    allocations
        .iter()
        .map(|allocation| match allocation {
            Value::Null => {
                Err("TypeError: Cannot read properties of null (reading 'supplyKey')".to_owned())
            }
            Value::Object(fields) => Ok(fields.get("supplyKey")),
            _ => Ok(None),
        })
        .collect()
}

/// Whether `new Set(keys).size === keys.length`: no key sent twice. An object is never the same
/// as another object.
fn distinct(keys: &[Option<&Value>]) -> bool {
    let mut seen = std::collections::HashSet::new();
    keys.iter().all(|key| {
        let identity = match key {
            None => "undefined".to_owned(),
            Some(Value::Object(_) | Value::Array(_)) => return true,
            Some(Value::Number(n)) => format!("n{}", js_float(n.as_f64().unwrap_or(f64::NAN))),
            Some(other) => other.to_string(),
        };
        seen.insert(identity)
    })
}

/// `allocations.reduce((sum, value) => sum + value.quantity, 0)` when it is a number: `null` adds
/// nothing and `true` one, as JavaScript adds them; anything else is not a number.
fn total(allocations: &[Value]) -> Option<f64> {
    allocations
        .iter()
        .try_fold(0.0, |sum, allocation| match allocation.get("quantity") {
            Some(Value::Number(n)) => n.as_f64().map(|n| sum + n),
            Some(Value::Null) => Some(sum),
            Some(Value::Bool(b)) => Some(sum + f64::from(u8::from(*b))),
            _ => None,
        })
}

/// A saved allocation, as Node's query names its columns.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
struct Segment {
    supply_key: String,
    receipt_id: i32,
    quantity: i32,
}

impl Segment {
    fn json(&self) -> Value {
        json!({ "supplyKey": self.supply_key, "receiptId": self.receipt_id, "quantity": self.quantity })
    }
}

/// `JSON.stringify(sent sorted by supplyKey) === JSON.stringify(saved)`, `saved` already in order.
fn same_segments(sent: &[Value], saved: &[Segment]) -> bool {
    let mut sent: Vec<&Value> = sent.iter().collect();
    sent.sort_by(|a, b| js_less_order(&a["supplyKey"], &b["supplyKey"]));
    sent.len() == saved.len()
        && sent.iter().zip(saved).all(|(sent, saved)| {
            sent.as_object().is_some_and(|fields| fields.len() == 3)
                && stable_json(&js_numbers(sent)) == stable_json(&saved.json())
        })
}

/// The order `(a, b) => a < b ? -1 : a > b ? 1 : 0` gives two supply keys.
fn js_less_order(a: &Value, b: &Value) -> Ordering {
    match (a.as_str(), b.as_str()) {
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        _ => Ordering::Equal,
    }
}

/// Node's `String(n)` of a number a request sent, for a query parameter Postgres reads as an
/// `integer`: a fraction is the database's refusal, as Node's was.
fn integer_text(n: f64) -> String {
    js_float(n)
}

async fn lock(conn: &mut PgConnection, seller: &str, sku: i32) -> Result<(), String> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("fifo:{seller}:{sku}"))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(node_pg::thrown)
}

async fn release_for_replay(conn: &mut PgConnection, seller: &str, sku: i32) -> Result<(), String> {
    sqlx::query(
        "UPDATE inventory_fifo_replay_queue SET status='pending',claim_token=NULL,claim_expires_at=NULL,
        hold_reason=NULL,updated_at=NOW() WHERE seller_key=$1 AND sku=$2",
    )
    .bind(seller)
    .bind(sku)
    .execute(&mut *conn)
    .await
    .map(|_| ())
    .map_err(node_pg::thrown)
}

#[derive(sqlx::FromRow)]
struct SavedDisposition {
    id: String,
    seller_key: String,
    order_number: String,
    sku_id: String,
    kind: String,
    quantity: i32,
    source_order_revision: i32,
    available_at: DateTime<Utc>,
    evidence: Value,
}

/// `recordDisposition`.
pub async fn record_disposition(
    conn: &mut PgConnection,
    mut input: Disposition,
) -> Result<Value, String> {
    input.seller_key = input.seller_key.trim().to_owned();
    input.request_id = input.request_id.trim().to_owned();
    input.order_number = input.order_number.trim().to_owned();
    input.sku_id = input.sku_id.trim().to_owned();
    let keys = supply_keys(&input.source_allocations)?;
    if input.request_id.is_empty()
        || input.quantity.fract() != 0.0
        || input.quantity <= 0.0
        || total(&input.source_allocations) != Some(input.quantity)
        || input.source_allocations.is_empty()
        || !distinct(&keys)
        || input.evidence.is_empty()
    {
        return refused("Complete disposition evidence is required.");
    }
    if let Some(id) = disposition_replay(conn, &input).await? {
        return Ok(recorded(id, true));
    }
    let order: Option<(String, DateTime<Utc>, String, i32)> = sqlx::query_as(
        "SELECT orders.id::text AS id,orders.order_time AS \"orderTime\",orders.lifecycle,
        orders.source_revision AS \"sourceRevision\" FROM seller_orders orders
        JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND orders.order_number=$2 AND line.sku_id=$3 FOR UPDATE OF orders",
    )
    .bind(&input.seller_key)
    .bind(&input.order_number)
    .bind(&input.sku_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let sku = standard_sku(&input.sku_id);
    let (Some((order_id, order_time, lifecycle, source_revision)), Some(sku)) = (order, sku) else {
        return refused("Disposition order evidence is stale or unsupported.");
    };
    let order_time = ms(order_time);
    if f64::from(source_revision) != input.source_order_revision || input.available_at < order_time
    {
        return refused("Disposition order evidence is stale or unsupported.");
    }
    let reserved: Option<String> = sqlx::query_scalar(
        "INSERT INTO inventory_fifo_replay_queue
          (seller_key,sku,affected_from,status,generation,claim_token,claim_expires_at)
        VALUES ($1,$2,$3,'processing',1,gen_random_uuid(),NOW()+INTERVAL '5 minutes')
        ON CONFLICT (seller_key,sku) DO UPDATE SET status='processing',claim_token=EXCLUDED.claim_token,
          claim_expires_at=EXCLUDED.claim_expires_at,hold_reason=NULL,updated_at=NOW()
        WHERE inventory_fifo_replay_queue.status='held' AND inventory_fifo_replay_queue.hold_reason IN
          ('cancellation_requires_disposition','canceled_after_shipping_requires_restock')
          OR inventory_fifo_replay_queue.status='held'
            AND inventory_fifo_replay_queue.hold_reason LIKE 'unexplained_inventory_difference:%'
        RETURNING seller_key AS \"sellerKey\"",
    )
    .bind(&input.seller_key)
    .bind(sku)
    .bind(order_time)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    if reserved.is_none() {
        if let Some(id) = disposition_replay(conn, &input).await? {
            return Ok(recorded(id, true));
        }
        return refused("FIFO allocation must be current before recording a disposition.");
    }
    lock(conn, &input.seller_key, sku).await?;
    let line: Option<(String, DateTime<Utc>, i32, i32, i32)> = sqlx::query_as(
        "SELECT id::text AS id,
        order_time AS \"orderTime\",source_order_revision AS \"sourceOrderRevision\",
        ordered_quantity AS \"orderedQuantity\",matched_quantity AS \"matchedQuantity\" FROM inventory_fifo_lines
        WHERE order_id=$1::text::bigint AND order_line_sku_id=$2 FOR UPDATE",
    )
    .bind(&order_id)
    .bind(&input.sku_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some((line_id, _, _, ordered, _)) = line.filter(|(_, time, revision, _, matched)| {
        *revision == source_revision
            && ms(*time) == order_time
            && f64::from(*matched) >= input.quantity
    }) else {
        return refused("Disposition exceeds or does not match the current FIFO allocation.");
    };
    let shipped: i32 = sqlx::query_scalar(
        "SELECT COUNT(*)::int AS count FROM seller_order_revisions
        WHERE order_id=$1::text::bigint AND lifecycle IN ('shipped_in_transit','shipped_delivered')",
    )
    .bind(&order_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    if input.disposition_type == "unfulfilled_cancellation"
        && (lifecycle != "canceled" || shipped > 0 || input.quantity != f64::from(ordered))
    {
        return refused(
            "Unfulfilled cancellation requires a fully matched, never-shipped canceled order.",
        );
    }
    let capacity: Vec<Segment> = sqlx::query_as(
        "SELECT allocation.supply_key,allocation.receipt_id,
        SUM(allocation.allocated_quantity)::int AS quantity FROM inventory_fifo_lines line
        JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=line.current_revision_id
        WHERE line.id=$1::text::bigint GROUP BY allocation.supply_key,allocation.receipt_id",
    )
    .bind(&line_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let prior: Vec<(String, i32)> = sqlx::query_as(
        "SELECT mapping.source_supply_key,SUM(mapping.quantity)::int AS quantity
        FROM inventory_stock_dispositions disposition JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.order_id=$1::text::bigint AND disposition.order_line_sku_id=$2
        GROUP BY mapping.source_supply_key",
    )
    .bind(&order_id)
    .bind(&input.sku_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    for requested in &input.source_allocations {
        let supply_key = match requested.get("supplyKey") {
            None | Some(Value::Null) => None,
            Some(Value::String(key)) => Some(key.as_str()),
            Some(_) => {
                return Err("TypeError: requested.supplyKey?.trim is not a function".to_owned());
            }
        };
        let quantity = &requested["quantity"];
        if supply_key.is_none_or(|key| key.trim().is_empty())
            || !is_integer(&requested["receiptId"])
            || !is_integer(quantity)
            || quantity.as_f64().is_some_and(|q| q <= 0.0)
        {
            return refused("Disposition source allocations are invalid.");
        }
        let supply_key = supply_key.unwrap_or_default();
        let receipt = requested["receiptId"].as_f64();
        let source = capacity
            .iter()
            .find(|c| c.supply_key == supply_key && Some(f64::from(c.receipt_id)) == receipt)
            .map_or(0, |c| c.quantity);
        let used = prior
            .iter()
            .find(|(key, _)| key == supply_key)
            .map_or(0, |(_, quantity)| *quantity);
        if quantity.as_f64().unwrap_or_default() > f64::from(source - used) {
            return refused("Disposition receipt lineage exceeds the active allocation.");
        }
    }
    let id: String = sqlx::query_scalar(
        "INSERT INTO inventory_stock_dispositions
        (request_id,seller_key,order_id,order_line_sku_id,sku,disposition_type,quantity,source_order_revision,
         source_ordered_quantity,available_at,evidence)
        VALUES ($1,$2,$3::text::bigint,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id::text AS id",
    )
    .bind(&input.request_id)
    .bind(&input.seller_key)
    .bind(&order_id)
    .bind(&input.sku_id)
    .bind(sku)
    .bind(&input.disposition_type)
    .bind(input.quantity as i32)
    .bind(source_revision)
    .bind(ordered)
    .bind(input.available_at)
    .bind(sqlx::types::Json(js_numbers(&Value::Object(input.evidence.clone()))))
    .fetch_one(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    sqlx::query(
        "INSERT INTO inventory_stock_disposition_receipts (disposition_id,source_supply_key,receipt_id,quantity)
        SELECT $1::text::bigint,x.\"supplyKey\",x.\"receiptId\",x.quantity FROM jsonb_to_recordset($2::jsonb)
          AS x(\"supplyKey\" text,\"receiptId\" integer,quantity integer)",
    )
    .bind(&id)
    .bind(sqlx::types::Json(js_numbers(&Value::Array(input.source_allocations.clone()))))
    .execute(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    release_for_replay(conn, &input.seller_key, sku).await?;
    Ok(recorded(id, false))
}

/// The disposition recorded under the request's id when it is this one; refused when it is another.
async fn disposition_replay(
    conn: &mut PgConnection,
    input: &Disposition,
) -> Result<Option<String>, String> {
    let existing: Option<SavedDisposition> = sqlx::query_as(
        "SELECT disposition.id::text AS id,disposition.seller_key,
          orders.order_number,disposition.order_line_sku_id AS sku_id,disposition.disposition_type AS kind,
          disposition.quantity,disposition.source_order_revision,disposition.available_at,
          disposition.evidence FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
          WHERE disposition.request_id=$1",
    )
    .bind(&input.request_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    let mappings = segments(
        conn,
        "SELECT source_supply_key AS supply_key,receipt_id,quantity
          FROM inventory_stock_disposition_receipts WHERE disposition_id=$1::text::bigint ORDER BY source_supply_key",
        &existing.id,
    )
    .await?;
    let same = existing.seller_key == input.seller_key
        && existing.order_number == input.order_number
        && existing.sku_id == input.sku_id
        && existing.kind == input.disposition_type
        && f64::from(existing.quantity) == input.quantity
        && f64::from(existing.source_order_revision) == input.source_order_revision
        && iso(existing.available_at) == iso(input.available_at)
        && same_evidence(&existing.evidence, &input.evidence)
        && same_segments(&input.source_allocations, &mappings);
    if !same {
        return refused("Disposition request ID conflicts.");
    }
    Ok(Some(existing.id))
}

fn same_evidence(saved: &Value, sent: &Map<String, Value>) -> bool {
    stable_json(&js_numbers(saved)) == stable_json(&js_numbers(&Value::Object(sent.clone())))
}

async fn segments(conn: &mut PgConnection, query: &str, id: &str) -> Result<Vec<Segment>, String> {
    sqlx::query_as(query)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(node_pg::thrown)
}

/// `supersedeDisposition`.
/// The disposition a supersession would correct, with what the order says now.
#[derive(sqlx::FromRow)]
struct DispositionToSupersede {
    available_at: DateTime<Utc>,
    quantity: i32,
    disposed_revision: i32,
    source_ordered: i32,
    current_revision: i32,
    current_quantity: i32,
    corrected: i32,
    quantity_corrected: i32,
}

pub async fn supersede_disposition(
    conn: &mut PgConnection,
    mut input: Supersession,
) -> Result<Value, String> {
    input.request_id = input.request_id.trim().to_owned();
    input.seller_key = input.seller_key.trim().to_owned();
    input.disposition_id = input.disposition_id.trim().to_owned();
    if let Some(id) = supersession_replay(conn, &input).await? {
        return Ok(recorded(id, true));
    }
    if input.evidence.is_empty() {
        return refused("Disposition correction evidence is required.");
    }
    let stale = "Disposition correction evidence is stale or predates the disposition.";
    let target: Option<(i32, DateTime<Utc>)> = sqlx::query_as(
        "SELECT disposition.sku,orders.order_time AS \"orderTime\"
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.id=$1::text::bigint AND disposition.seller_key=$2",
    )
    .bind(&input.disposition_id)
    .bind(&input.seller_key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some((sku, order_time)) = target else {
        return refused(stale);
    };
    enqueue(conn, &input.seller_key, sku, ms(order_time))
        .await
        .map_err(node_pg::thrown)?;
    lock(conn, &input.seller_key, sku).await?;
    if let Some(id) = supersession_replay(conn, &input).await? {
        return Ok(recorded(id, true));
    }
    let disposition: Option<DispositionToSupersede> = sqlx::query_as(
        "SELECT disposition.available_at,disposition.quantity,
        disposition.source_order_revision AS disposed_revision,
        disposition.source_ordered_quantity AS source_ordered,
        orders.source_revision AS current_revision,COALESCE(line.ordered_quantity,0)::int AS current_quantity,
        (SELECT COALESCE(SUM(other.quantity),0)::int FROM inventory_stock_dispositions other
          JOIN inventory_stock_disposition_corrections other_correction ON other_correction.disposition_id=other.id
          WHERE other.order_id=disposition.order_id AND other.order_line_sku_id=disposition.order_line_sku_id
            AND other_correction.source_order_revision=$3::text::integer) AS corrected,
        (SELECT COALESCE(SUM(quantity_correction.released_quantity),0)::int
          FROM inventory_order_quantity_corrections quantity_correction
          WHERE quantity_correction.order_id=disposition.order_id
            AND quantity_correction.order_line_sku_id=disposition.order_line_sku_id
            AND quantity_correction.source_order_revision=$3::text::integer) AS quantity_corrected
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        LEFT JOIN seller_order_lines line ON line.order_id=orders.id AND line.sku_id=disposition.order_line_sku_id
        WHERE disposition.id=$1::text::bigint AND disposition.seller_key=$2 FOR UPDATE OF disposition",
    )
    .bind(&input.disposition_id)
    .bind(&input.seller_key)
    .bind(integer_text(input.source_order_revision))
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some(DispositionToSupersede {
        available_at,
        quantity,
        disposed_revision,
        source_ordered,
        current_revision,
        current_quantity: current,
        corrected,
        quantity_corrected,
    }) = disposition
    else {
        return refused(stale);
    };
    if f64::from(current_revision) != input.source_order_revision
        || input.source_order_revision <= f64::from(disposed_revision)
        || source_ordered - current < corrected + quantity_corrected + quantity
        || input.confirmed_at < ms(available_at)
    {
        return refused(stale);
    }
    let id: String = sqlx::query_scalar(
        "INSERT INTO inventory_stock_disposition_corrections
        (request_id,disposition_id,action,source_order_revision,evidence,confirmed_at)
        VALUES ($1,$2::text::bigint,'provider_revision_accounts_for_return',$3,$4::jsonb,$5) RETURNING id::text AS id",
    )
    .bind(&input.request_id)
    .bind(&input.disposition_id)
    .bind(current_revision)
    .bind(sqlx::types::Json(js_numbers(&Value::Object(input.evidence.clone()))))
    .bind(input.confirmed_at)
    .fetch_one(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    Ok(recorded(id, false))
}

async fn supersession_replay(
    conn: &mut PgConnection,
    input: &Supersession,
) -> Result<Option<String>, String> {
    let existing: Option<(String, String, String, i32, DateTime<Utc>, Value)> = sqlx::query_as(
        "SELECT correction.id::text AS id,correction.disposition_id::text AS \"dispositionId\",
          disposition.seller_key AS \"sellerKey\",correction.source_order_revision AS \"sourceOrderRevision\",
          correction.confirmed_at AS \"confirmedAt\",correction.evidence
          FROM inventory_stock_disposition_corrections correction JOIN inventory_stock_dispositions disposition
            ON disposition.id=correction.disposition_id WHERE correction.request_id=$1",
    )
    .bind(&input.request_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some((id, disposition, seller, revision, confirmed_at, evidence)) = existing else {
        return Ok(None);
    };
    if seller != input.seller_key
        || disposition != input.disposition_id
        || f64::from(revision) != input.source_order_revision
        || iso(confirmed_at) != iso(input.confirmed_at)
        || !same_evidence(&evidence, &input.evidence)
    {
        return refused("Disposition correction request ID conflicts.");
    }
    Ok(Some(id))
}

/// `recordQuantityCorrection`.
pub async fn record_quantity_correction(
    conn: &mut PgConnection,
    mut input: QuantityCorrection,
) -> Result<Value, String> {
    input.request_id = input.request_id.trim().to_owned();
    input.seller_key = input.seller_key.trim().to_owned();
    input.order_number = input.order_number.trim().to_owned();
    input.sku_id = input.sku_id.trim().to_owned();
    if let Some(id) = quantity_correction_replay(conn, &input).await? {
        return Ok(recorded(id, true));
    }
    if input.request_id.is_empty()
        || input.evidence.is_empty()
        || input.source_allocations.is_empty()
        || !distinct(&supply_keys(&input.source_allocations)?)
    {
        return refused(
            "Complete quantity correction evidence and source allocations are required.",
        );
    }
    let Some(sku) = standard_sku(&input.sku_id) else {
        return refused("Quantity correction SKU is unsupported.");
    };
    let order_id: Option<String> = sqlx::query_scalar(
        "SELECT orders.id::text AS \"orderId\"
        FROM seller_orders orders WHERE orders.seller_key=$1 AND orders.order_number=$2",
    )
    .bind(&input.seller_key)
    .bind(&input.order_number)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some(order_id) = order_id else {
        return refused("Quantity correction order was not found.");
    };
    let reserved: Option<String> = sqlx::query_scalar(
        "UPDATE inventory_fifo_replay_queue SET status='processing',
          claim_token=gen_random_uuid(),claim_expires_at=NOW()+INTERVAL '5 minutes',hold_reason=NULL,updated_at=NOW()
        WHERE seller_key=$1 AND sku=$2 AND status='held'
          AND (hold_reason LIKE 'order_quantity_decrease_requires_correction:%'
            OR hold_reason LIKE 'unexplained_inventory_difference:%')
        RETURNING seller_key AS \"sellerKey\"",
    )
    .bind(&input.seller_key)
    .bind(sku)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    if reserved.is_none() {
        if let Some(id) = quantity_correction_replay(conn, &input).await? {
            return Ok(recorded(id, true));
        }
        return refused("FIFO must hold an unresolved quantity decrease before correction.");
    }
    lock(conn, &input.seller_key, sku).await?;
    #[allow(clippy::type_complexity, reason = "the columns of one query")]
    let line: Option<(String, i32, i32, i32, i32, i32, DateTime<Utc>, i32, i32)> = sqlx::query_as(
        "SELECT saved.id::text AS id,saved.ordered_quantity AS \"previousQuantity\",
          saved.matched_quantity AS \"previousMatchedQuantity\",
          saved.source_order_revision AS \"previousSourceRevision\",COALESCE(current_line.ordered_quantity,0)::int AS \"currentQuantity\",
          orders.source_revision AS \"currentSourceRevision\",revision.observed_at AS \"revisionObservedAt\",
          (SELECT COUNT(*)::int FROM inventory_stock_dispositions disposition
            WHERE disposition.order_id=orders.id AND disposition.order_line_sku_id=saved.order_line_sku_id
              AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections corrected
                WHERE corrected.disposition_id=disposition.id)) AS \"activeDispositionCount\",
          (SELECT COALESCE(SUM(disposition.quantity),0)::int FROM inventory_stock_dispositions disposition
            JOIN inventory_stock_disposition_corrections corrected ON corrected.disposition_id=disposition.id
            WHERE disposition.order_id=orders.id AND disposition.order_line_sku_id=saved.order_line_sku_id
              AND corrected.source_order_revision=orders.source_revision) AS \"claimedDispositionCorrectionQuantity\"
        FROM seller_orders orders JOIN inventory_fifo_lines saved ON saved.order_id=orders.id AND saved.order_line_sku_id=$3
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=orders.id AND current_line.sku_id=saved.order_line_sku_id
        JOIN seller_order_revisions revision ON revision.order_id=orders.id AND revision.revision_number=orders.source_revision
        WHERE orders.id=$1::text::bigint AND orders.seller_key=$2",
    )
    .bind(&order_id)
    .bind(&input.seller_key)
    .bind(&input.sku_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let stale =
        "Quantity correction source revision is stale, disposition-backed, or not a decrease.";
    let Some((
        line_id,
        previous,
        previous_matched,
        previous_revision,
        current,
        current_revision,
        observed_at,
        active,
        claimed,
    )) = line
    else {
        return refused(stale);
    };
    let released = (previous_matched - current).max(0);
    if f64::from(current_revision) != input.source_order_revision
        || f64::from(previous_revision) >= input.source_order_revision
        || active > 0
        || released <= 0
        || previous - current < released + claimed
        || input.available_at < ms(observed_at)
    {
        return refused(stale);
    }
    let active_segments = segments(
        conn,
        "SELECT allocation.supply_key,allocation.receipt_id,
          allocation.allocated_quantity AS quantity FROM inventory_fifo_revision_allocations allocation
        JOIN inventory_fifo_lines saved ON saved.current_revision_id=allocation.revision_id
        JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
        WHERE saved.id=$1::text::bigint ORDER BY receipt.fifo_precedence DESC,receipt.intake_at DESC NULLS LAST,
          receipt.receipt_id DESC,allocation.supply_key DESC",
        &line_id,
    )
    .await?;
    let mut needed = released.min(active_segments.iter().map(|s| s.quantity).sum());
    let mut expected = Vec::new();
    for segment in &active_segments {
        if needed <= 0 {
            break;
        }
        let quantity = needed.min(segment.quantity);
        expected.push(Segment {
            quantity,
            ..segment.clone()
        });
        needed -= quantity;
    }
    let mut sorted = expected.clone();
    sorted.sort_by(|a, b| a.supply_key.encode_utf16().cmp(b.supply_key.encode_utf16()));
    if expected.is_empty() || !same_segments(&input.source_allocations, &sorted) {
        return refused(
            "Quantity correction must release the newest exact active allocation segments.",
        );
    }
    let id: String = sqlx::query_scalar(
        "INSERT INTO inventory_order_quantity_corrections
          (request_id,seller_key,order_id,order_line_sku_id,sku,previous_quantity,corrected_quantity,
           released_quantity,source_order_revision,available_at,evidence)
        VALUES ($1,$2,$3::text::bigint,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id::text AS id",
    )
    .bind(&input.request_id)
    .bind(&input.seller_key)
    .bind(&order_id)
    .bind(&input.sku_id)
    .bind(sku)
    .bind(previous)
    .bind(current)
    .bind(expected.iter().map(|s| s.quantity).sum::<i32>())
    .bind(current_revision)
    .bind(input.available_at)
    .bind(sqlx::types::Json(js_numbers(&Value::Object(input.evidence.clone()))))
    .fetch_one(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let expected: Vec<Value> = expected.iter().map(Segment::json).collect();
    sqlx::query(
        "INSERT INTO inventory_order_quantity_correction_allocations
          (correction_id,source_supply_key,receipt_id,quantity)
        SELECT $1::text::bigint,x.\"supplyKey\",x.\"receiptId\",x.quantity FROM jsonb_to_recordset($2::jsonb)
          AS x(\"supplyKey\" text,\"receiptId\" integer,quantity integer)",
    )
    .bind(&id)
    .bind(sqlx::types::Json(Value::Array(expected)))
    .execute(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    release_for_replay(conn, &input.seller_key, sku).await?;
    Ok(recorded(id, false))
}

/// A quantity correction already recorded under the request's id.
#[derive(sqlx::FromRow)]
struct SavedQuantityCorrection {
    id: String,
    seller: String,
    order_number: String,
    sku_id: String,
    revision: i32,
    available_at: DateTime<Utc>,
    evidence: Value,
}

async fn quantity_correction_replay(
    conn: &mut PgConnection,
    input: &QuantityCorrection,
) -> Result<Option<String>, String> {
    let existing: Option<SavedQuantityCorrection> =
        sqlx::query_as(
            "SELECT correction.id::text AS id,correction.seller_key AS seller,
          orders.order_number AS order_number,correction.order_line_sku_id AS sku_id,
          correction.source_order_revision AS revision,correction.available_at,
          correction.evidence FROM inventory_order_quantity_corrections correction
          JOIN seller_orders orders ON orders.id=correction.order_id WHERE correction.request_id=$1",
        )
        .bind(&input.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(node_pg::thrown)?;
    let Some(SavedQuantityCorrection {
        id,
        seller,
        order_number: order,
        sku_id,
        revision,
        available_at,
        evidence,
    }) = existing
    else {
        return Ok(None);
    };
    // Sorting a list of two or more compares them, which reads a `null` one's key.
    if input.source_allocations.len() > 1 && input.source_allocations.iter().any(Value::is_null) {
        return Err("TypeError: Cannot read properties of null (reading 'supplyKey')".to_owned());
    }
    let mappings = segments(
        conn,
        "SELECT source_supply_key AS supply_key,receipt_id,quantity
          FROM inventory_order_quantity_correction_allocations WHERE correction_id=$1::text::bigint ORDER BY source_supply_key",
        &id,
    )
    .await?;
    if seller != input.seller_key
        || order != input.order_number
        || sku_id != input.sku_id
        || f64::from(revision) != input.source_order_revision
        || iso(available_at) != iso(input.available_at)
        || !same_evidence(&evidence, &input.evidence)
        || !same_segments(&input.source_allocations, &mappings)
    {
        return refused("Quantity correction request ID conflicts.");
    }
    Ok(Some(id))
}
