//! Handing what was counted off as a pricing batch, and the batches handed off, ported from the
//! Node app's `/api/inventory-intake-runs` (`queueInventoryIntake`,
//! `findRecentInventoryIntakeRuns`): a batch is queued once per request id, refused when the
//! counts or the seller moved since the screen showed them, costed (an entered total split by
//! units, or an estimate at its rate) and queued for pricing in full; the latest 25 are listed.
//!
//! Node's route also starts its pricing and publication workers in its own process, unless
//! `WORKERS_RUN_IN_PROCESS=false`. This process cannot. In production the workers are processes
//! of their own that poll every second, so they find the job. In development Node's in-process
//! worker prices it once any Node route has started it, as for the jobs a CSV import or a
//! strategy analysis queues here.
use std::collections::HashMap;

use corten::{Refusal, UrlValue, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::PgConnection;

use crate::{
    api::js_trim,
    database::Database,
    features::{
        batch_pricing::queue as batch_queue,
        continuous_pricing::{self, scheduler},
        inventory_economics::{
            details::{calendar_date, dollars_to_cents, js_dollars, js_length, required_text},
            estimate::{self, PurchaseCost},
            purchase_cost::{self, NotRecorded},
        },
        publication_configuration, shipping_configuration,
    },
};

/// What queuing does with the batch: price it, or price it and publish what is ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Workflow {
    PriceOnly,
    Publish,
}

impl Workflow {
    /// As the Node app stores it.
    pub fn word(self) -> &'static str {
        match self {
            Workflow::PriceOnly => "price_only",
            Workflow::Publish => "publish",
        }
    }
}

/// How the next batch is costed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostMethod {
    /// The default rate.
    #[default]
    Estimate,
    /// A rate the user enters, which stays for the lot's later batches.
    CostRate,
    /// What this handoff cost, split across its cards by quantity.
    PurchaseTotal,
}

pub use crate::features::inventory_economics::estimate::CostRate;

/// The most a rate may take off each card: $100.00.
const MAXIMUM_DEDUCTION_CENTS: i64 = 10_000;

/// `$16.50`, `-$0.20`: signed whole cents as US dollars.
pub fn dollars(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}${}.{:02}", cents.abs() / 100, cents.abs() % 100)
}

/// A nonnegative amount with at most two decimals, in cents: `0.3` is 30.
fn cents(text: &str) -> Option<i64> {
    dollars_to_cents(text, "Amount").ok()
}

/// The percent of market as typed (0 to 100, at most two decimals), or why not, in the Node
/// app's words.
pub fn read_market_percent(text: &str) -> Result<f64, &'static str> {
    match cents(text) {
        Some(hundredths) if hundredths <= 10_000 => Ok(hundredths as f64 / 10_000.0),
        _ => Err("Percent of market must be between 0 and 100 with at most two decimal places."),
    }
}

/// The amount less per card as typed (at most $100.00), in cents, or why not.
pub fn read_per_card_deduction(text: &str) -> Result<i64, String> {
    at_most_a_deduction(dollars_to_cents(text, DEDUCTION)?)
}

const DEDUCTION: &str = "Amount less per card";

fn at_most_a_deduction(cents: i64) -> Result<i64, String> {
    if cents > MAXIMUM_DEDUCTION_CENTS {
        Err("Amount less per card must be at most $100.00.".to_owned())
    } else {
        Ok(cents)
    }
}

/// The queue bar's form: the cost of the batch, what queuing does (its button), and what the
/// screen showed (the counts' fingerprint and the seller), so a queue that moved is refused.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct QueueInput {
    pub request: Option<SubmitKey>,
    pub workflow: Option<Workflow>,
    #[serde(default)]
    pub counted: String,
    #[serde(default)]
    pub seller: String,
    #[serde(default)]
    pub cost: CostMethod,
    #[serde(default)]
    pub market_percent: String,
    #[serde(default)]
    pub per_card_deduction: String,
    #[serde(default)]
    pub purchase_reference: String,
    #[serde(default)]
    pub purchase_total: String,
    #[serde(default)]
    pub purchase_date: String,
    #[serde(default)]
    pub purchase_estimated: bool,
}

/// The cost a batch is queued with.
#[derive(Clone, Debug, PartialEq)]
pub enum Cost {
    Estimate,
    Rate(CostRate),
    Purchase {
        reference: String,
        total: String,
        date: Option<String>,
        estimated: bool,
    },
}

impl Cost {
    /// How the success message names it: `an estimate at the default 75% of market ...`.
    pub fn described(&self) -> String {
        match self {
            Cost::Estimate => format!(
                "an estimate at the default {}",
                CostRate::DEFAULT.describe()
            ),
            Cost::Rate(rate) => format!("an estimate at {}", rate.describe()),
            Cost::Purchase { .. } => "the entered purchase total".to_owned(),
        }
    }
}

impl QueueInput {
    /// The form as first drawn: the default estimate.
    pub fn new() -> Self {
        QueueInput::default().filled()
    }

    /// The form with the default rate in rate fields it did not send: they are disabled, so not
    /// sent, while another cost is chosen, and drawn again they would be blank. A rate chosen and
    /// left blank stays blank, to be refused.
    pub fn filled(mut self) -> Self {
        if self.cost == CostMethod::CostRate {
            return self;
        }
        if self.market_percent.trim().is_empty() {
            self.market_percent = CostRate::DEFAULT.market_percent();
        }
        if self.per_card_deduction.trim().is_empty() {
            self.per_card_deduction = CostRate::DEFAULT.per_card_deduction();
        }
        self
    }

    /// The form for the batch after this one: a rate describes the whole lot, so it stays; a
    /// purchase total belongs to one handoff, so it clears.
    pub fn after_queue(&self) -> Self {
        QueueInput {
            cost: match self.cost {
                CostMethod::PurchaseTotal => CostMethod::Estimate,
                other => other,
            },
            market_percent: self.market_percent.clone(),
            per_card_deduction: self.per_card_deduction.clone(),
            ..QueueInput::default()
        }
        .filled()
    }

    /// The cost the form asks for, or each field that is wrong.
    pub fn read_cost(&self) -> Result<Cost, Errors> {
        let f = QueueInput::FIELDS;
        let mut errors = Errors::new();
        let cost = match self.cost {
            CostMethod::Estimate => Cost::Estimate,
            CostMethod::CostRate => {
                let percent = read_market_percent(&self.market_percent);
                let deduction = read_per_card_deduction(&self.per_card_deduction);
                if let Err(message) = percent {
                    errors.add(f.market_percent, message);
                }
                if let Err(message) = &deduction {
                    errors.add(f.per_card_deduction, message.as_str());
                }
                match (percent, deduction) {
                    (Ok(market_rate), Ok(per_unit_deduction_cents)) => Cost::Rate(CostRate {
                        market_rate,
                        per_unit_deduction_cents,
                    }),
                    _ => Cost::Estimate,
                }
            }
            CostMethod::PurchaseTotal => {
                let reference = self.purchase_reference.trim();
                let total = self.purchase_total.trim().trim_start_matches('$').trim();
                if reference.is_empty() {
                    errors.add(
                        f.purchase_reference,
                        "Enter the purchase reference before queuing.",
                    );
                }
                if let Err(message) = dollars_to_cents(total, "Purchase total") {
                    errors.add(f.purchase_total, message);
                }
                let date = self.purchase_date.trim();
                Cost::Purchase {
                    reference: reference.to_owned(),
                    total: total.to_owned(),
                    date: (!date.is_empty()).then(|| date.to_owned()),
                    estimated: self.purchase_estimated,
                }
            }
        };
        errors.into_result(cost)
    }
}

/// One SKU's count as the queue request names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct IntakeQuantity {
    pub sku: i64,
    pub quantity: i64,
}

/// The counts in SKU order, as the Node app compares them.
pub fn snapshot(quantities: &HashMap<i32, i32>) -> Vec<IntakeQuantity> {
    let mut items: Vec<IntakeQuantity> = quantities
        .iter()
        .map(|(&sku, &quantity)| IntakeQuantity {
            sku: sku.into(),
            quantity: quantity.into(),
        })
        .collect();
    items.sort_by_key(|i| i.sku);
    items
}

/// A short, stable fingerprint of the counts (FNV-1a over them in SKU order). The screen carries
/// the one it was drawn with, so queuing counts it did not show is refused before anything is sent.
pub fn fingerprint(quantities: &HashMap<i32, i32>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for item in snapshot(quantities) {
        for byte in format!("{}:{};", item.sku, item.quantity).bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// A batch queued, or the one a request queued before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Queued {
    pub batch_number: i32,
}

/// Why a batch was not queued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotQueued {
    /// Refused, in the Node app's words: input it would not take (its 400), or counts, a seller
    /// or a request that moved on (its 409).
    Refused(Refusal, String),
    /// Its cost could not be recorded for a reason other than a conflict with what is recorded
    /// (no receipt lots, say): Node's 500, whose message its screen showed.
    Unrecorded(String),
    /// The database failed.
    Failed(String),
}

impl From<sqlx::Error> for NotQueued {
    fn from(e: sqlx::Error) -> Self {
        NotQueued::Failed(e.to_string())
    }
}

fn invalid(message: impl Into<String>) -> NotQueued {
    NotQueued::Refused(Refusal::Invalid, message.into())
}

fn conflict(message: impl Into<String>) -> NotQueued {
    NotQueued::Refused(Refusal::Conflict, message.into())
}

/// A cost not recorded: a conflict with what is recorded (Node's `InventoryEconomicsConflictError`,
/// its 409), or anything else (its 500).
fn unrecorded(not: NotRecorded) -> NotQueued {
    match not {
        NotRecorded::Conflict(message) => conflict(message),
        NotRecorded::Failed(message) => NotQueued::Unrecorded(message),
    }
}

/// `parseIntakePurchaseCost`: the entered total as the purchase cost the batch records, split
/// across its lots by their units, or why not, each field checked in Node's order. It names no
/// batch until the batch exists.
fn purchase_cost(
    request_id: &str,
    seller_key: &str,
    fields: &Map<String, Value>,
) -> Result<PurchaseCost, String> {
    if fields.get("allocationRule").and_then(Value::as_str) != Some("quantity") {
        return Err("Intake purchase cost supports quantity allocation.".to_owned());
    }
    let total_amount_cents = js_dollars(fields.get("totalAmount"), "Purchase total")?;
    // `normalizePurchaseCostDetails`: the currency, upper-cased, then the rest.
    let currency = match fields.get("currency") {
        None => "USD".to_owned(),
        Some(Value::String(text)) => required_text(text, "Currency")?.to_uppercase(),
        Some(_) => return Err("Currency is required.".to_owned()),
    };
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("Currency must be a three-letter code.".to_owned());
    }
    let provenance = match fields.get("provenance").and_then(Value::as_str) {
        Some("actual") => "actual",
        Some("estimated") => "estimated",
        _ => return Err("Purchase provenance is invalid.".to_owned()),
    };
    let purchased_at = match fields.get("purchasedAt") {
        None => None,
        Some(Value::String(text)) => calendar_date(Some(text))?,
        Some(_) => return Err("Purchase date must be text.".to_owned()),
    };
    let request_id = required_text(&format!("{request_id}:purchase-cost"), "Request ID")?;
    let seller_key = required_text(seller_key, "Seller key")?;
    let purchase_reference = match fields.get("purchaseReference") {
        Some(Value::String(text)) => required_text(text, "Purchase reference")?,
        _ => return Err("Purchase reference is required.".to_owned()),
    };
    Ok(PurchaseCost {
        request_id,
        seller_key,
        purchase_reference,
        currency,
        total_amount_cents,
        provenance,
        source: "intake",
        allocation_rule: "quantity",
        batch_numbers: Vec::new(),
        purchased_at,
        market_observed_at: None,
        explicit_allocations: Vec::new(),
        corrects_entry_id: None,
        correction_reason: None,
    })
}

/// `parseEstimatedCostRate`: the rate from its fields as sent; only text is read.
pub fn cost_rate(fields: &Map<String, Value>) -> Result<CostRate, String> {
    let percent = fields
        .get("marketPercent")
        .and_then(Value::as_str)
        .unwrap_or("");
    let market_rate = read_market_percent(percent)?;
    let deduction = js_dollars(fields.get("perCardDeduction"), DEDUCTION)?;
    Ok(CostRate {
        market_rate,
        per_unit_deduction_cents: at_most_a_deduction(deduction)?,
    })
}

/// What a queue request carries besides its id: what queuing does, the cost's fields as sent
/// (an entered purchase total, or a rate; Node's `purchaseCost` and `estimatedCostRate`, read
/// only once the queue is checked), and the counts and seller the screen showed.
pub struct Queue<'a> {
    pub workflow: Workflow,
    pub purchase_cost: Option<Map<String, Value>>,
    pub estimated_cost_rate: Option<Map<String, Value>>,
    pub expected: &'a [IntakeQuantity],
    pub seller_key: &'a str,
}

impl<'a> Queue<'a> {
    /// The request the queue bar's form makes for `cost`, as the React screen sent it.
    pub fn entered(
        workflow: Workflow,
        cost: &Cost,
        expected: &'a [IntakeQuantity],
        seller_key: &'a str,
    ) -> Self {
        let object = |value: serde_json::Value| match value {
            Value::Object(fields) => fields,
            _ => unreachable!("a cost's fields are an object"),
        };
        let (purchase_cost, estimated_cost_rate) = match cost {
            Cost::Estimate => (None, None),
            Cost::Rate(rate) => (
                None,
                Some(object(serde_json::json!({
                    "marketPercent": rate.market_percent(),
                    "perCardDeduction": rate.per_card_deduction(),
                }))),
            ),
            Cost::Purchase {
                reference,
                total,
                date,
                estimated,
            } => {
                let mut fields = object(serde_json::json!({
                    "purchaseReference": reference,
                    "totalAmount": total,
                    "provenance": if *estimated { "estimated" } else { "actual" },
                    "allocationRule": "quantity",
                    "currency": "USD",
                }));
                if let Some(date) = date {
                    fields.insert("purchasedAt".into(), date.as_str().into());
                }
                (Some(fields), None)
            }
        };
        Queue {
            workflow,
            purchase_cost,
            estimated_cost_rate,
            expected,
            seller_key,
        }
    }

    fn costed(&self) -> bool {
        self.purchase_cost.is_some() || self.estimated_cost_rate.is_some()
    }
}

/// What a request asked for, as the Node app saves it (`request_json`) and compares a repeat
/// of it: what queuing does, the cost as sent, the rate only when one was, and the counts in SKU
/// order with the seller the screen showed.
fn details(queue: &Queue<'_>) -> Value {
    let mut expected = queue.expected.to_vec();
    expected.sort_by_key(|i| i.sku);
    let mut details = serde_json::json!({
        "workflow": queue.workflow,
        "purchaseCost": queue.purchase_cost.clone().map_or(Value::Null, Value::Object),
        "expectedInventory": expected,
        "expectedSellerKey": queue.seller_key,
    });
    if let Some(rate) = &queue.estimated_cost_rate {
        details["estimatedCostRate"] = Value::Object(rate.clone());
    }
    details
}

/// What the Node route refuses before it looks at the queue: a request id that is blank or
/// longer than 180, counts that are not 1 to 5,000 distinct SKUs each with a positive count, or
/// a seller key longer than 200.
fn well_formed(request_id: &str, queue: &Queue<'_>) -> bool {
    let mut skus: Vec<i64> = queue.expected.iter().map(|i| i.sku).collect();
    skus.sort_unstable();
    !js_trim(request_id).is_empty()
        && js_length(request_id) <= 180
        && (1..=5000).contains(&queue.expected.len())
        && queue.expected.iter().all(|i| i.sku > 0 && i.quantity > 0)
        && skus.windows(2).all(|pair| pair[0] != pair[1])
        && js_length(queue.seller_key) <= 200
}

/// Why the target refuses what the request asks, in the Node app's words: publishing for a
/// seller it may not publish for, or a cost or publication with no seller to record it for.
fn refusal(target: &Target, queue: &Queue<'_>) -> Option<String> {
    if queue.workflow == Workflow::Publish && !target.can_publish {
        return target.publishing_unavailable_reason.clone();
    }
    let needs_seller = queue.workflow == Workflow::Publish || queue.costed();
    (needs_seller && target.seller_key.is_empty()).then(|| {
        "Configure a default shipping seller before queuing publication or purchase cost."
            .to_owned()
    })
}

/// `createFromPendingInventory`: the counted inventory locked and moved into a new batch with
/// its receipt lots linked (each lot as its adjustments leave it), or none when nothing is
/// counted. What is counted while this runs stays for the next batch.
async fn create_batch(conn: &mut PgConnection, request_id: &str) -> sqlx::Result<Option<i32>> {
    let skus: Vec<i32> =
        sqlx::query_scalar("SELECT sku FROM pending_inventory ORDER BY created_at FOR UPDATE")
            .fetch_all(&mut *conn)
            .await?;
    if skus.is_empty() {
        return Ok(None);
    }
    let batch_number: i32 = sqlx::query_scalar(
        "INSERT INTO inventory_batches (status, source_type, source_label, source_request_id)
        VALUES ('pending', 'pending_inventory', 'Inventory Manager', $1)
        RETURNING batch_number",
    )
    .bind(request_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO inventory_batch_intake_requests (request_id, batch_number) VALUES ($1, $2)",
    )
    .bind(request_id)
    .bind(batch_number)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO inventory_batch_items (batch_number, sku, total_quantity, add_to_quantity,
          current_price, product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
        SELECT $1, sku, 0, quantity, NULL, product_line_id, set_id, product_id, NULL, created_at, updated_at
        FROM pending_inventory WHERE sku = ANY($2::int[])",
    )
    .bind(batch_number)
    .bind(&skus)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "WITH adjusted_receipts AS (
          SELECT receipt.receipt_id,
            receipt.original_quantity + COALESCE(SUM(adjustment.quantity_delta), 0)::integer AS quantity
          FROM inventory_receipts receipt
          JOIN pending_inventory pending ON pending.sku = receipt.sku
          LEFT JOIN inventory_receipt_adjustments adjustment ON adjustment.receipt_id = receipt.receipt_id
          WHERE receipt.receipt_kind = 'received'
            AND pending.sku = ANY($2::int[])
            AND NOT EXISTS (SELECT 1 FROM inventory_receipt_batch_links existing_link
              WHERE existing_link.receipt_id = receipt.receipt_id)
          GROUP BY receipt.receipt_id
        )
        INSERT INTO inventory_receipt_batch_links (receipt_id, batch_number, linked_quantity)
        SELECT receipt_id, $1, quantity FROM adjusted_receipts WHERE quantity > 0",
    )
    .bind(batch_number)
    .bind(&skus)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM pending_inventory WHERE sku = ANY($1::int[])")
        .bind(&skus)
        .execute(&mut *conn)
        .await?;
    Ok(Some(batch_number))
}

/// `queueInventoryIntake` on `conn`, which the caller holds in a transaction: the counts as
/// a batch once per request id, costed and queued for pricing in full, under the lock every
/// change to the counts takes. A request the screen drew against other counts or another seller
/// is refused; the same request again answers the batch it queued.
pub async fn queued(
    conn: &mut PgConnection,
    request_id: &str,
    queue: &Queue<'_>,
    target: &Target,
    config: &serde_json::Value,
) -> Result<Queued, NotQueued> {
    if !well_formed(request_id, queue) {
        return Err(invalid(
            "A request ID and valid queue options are required.",
        ));
    }
    let request_id = js_trim(request_id);
    let details = details(queue);
    sqlx::query("SELECT pg_advisory_xact_lock(55, 0)")
        .execute(&mut *conn)
        .await?;
    let previous: Option<(i32, serde_json::Value)> = sqlx::query_as(
        "SELECT batch_number, request_json FROM inventory_intake_runs WHERE request_id = $1",
    )
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((batch_number, saved)) = previous {
        if saved != details {
            return Err(conflict(
                "This request already queued different options. Recover the original request first.",
            ));
        }
        return Ok(Queued { batch_number });
    }
    let used: Option<String> = sqlx::query_scalar(
        "SELECT request_id FROM inventory_batch_intake_requests WHERE request_id = $1",
    )
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await?;
    if used.is_some() {
        return Err(conflict(
            "This request belongs to an earlier or deleted batch.",
        ));
    }
    let current: Vec<(i64, i64)> =
        sqlx::query_as("SELECT sku::int8, quantity::int8 FROM pending_inventory ORDER BY sku")
            .fetch_all(&mut *conn)
            .await?;
    let current: Vec<IntakeQuantity> = current
        .into_iter()
        .map(|(sku, quantity)| IntakeQuantity { sku, quantity })
        .collect();
    if serde_json::to_value(&current).ok().as_ref() != details.get("expectedInventory") {
        return Err(conflict(
            "The shared inventory queue changed. Review the refreshed quantities and queue again. No inventory was handed off.",
        ));
    }
    if target.seller_key != queue.seller_key {
        return Err(conflict(
            "The intake seller changed. Refresh and review the seller before queuing again.",
        ));
    }
    if let Some(why) = refusal(target, queue) {
        return Err(invalid(why));
    }
    if queue.purchase_cost.is_some() && queue.estimated_cost_rate.is_some() {
        return Err(invalid("Enter a purchase total or a cost rate, not both."));
    }
    let seller = target.seller_key.as_str();
    let purchase = queue
        .purchase_cost
        .as_ref()
        .map(|fields| purchase_cost(request_id, seller, fields))
        .transpose()
        .map_err(invalid)?;
    let rate = queue
        .estimated_cost_rate
        .as_ref()
        .map(cost_rate)
        .transpose()
        .map_err(invalid)?;
    let batch_number = create_batch(conn, request_id)
        .await?
        .ok_or_else(|| invalid("No saved inventory is available to queue."))?;
    if let Some(rate) = rate {
        estimate::save_rate(&mut *conn, batch_number, rate).await?;
    }
    if let Some(mut cost) = purchase {
        cost.batch_numbers = vec![batch_number];
        purchase_cost::record(conn, &cost)
            .await
            .map_err(unrecorded)?;
    } else if !seller.is_empty() {
        estimate::record_batch(conn, seller, batch_number)
            .await
            .map_err(unrecorded)?;
    }
    let job = batch_queue::create_or_reuse(conn, batch_number, "full", config)
        .await?
        .ok_or_else(|| NotQueued::Failed(format!("Batch {batch_number} was not saved.")))?;
    sqlx::query(
        "INSERT INTO inventory_intake_runs
          (request_id, batch_number, pricing_job_id, workflow, request_json, seller_key)
        VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(request_id)
    .bind(batch_number)
    .bind(job.id)
    .bind(queue.workflow.word())
    .bind(&details)
    .bind((!seller.is_empty()).then_some(seller))
    .execute(&mut *conn)
    .await?;
    Ok(Queued { batch_number })
}

/// `createPendingInventoryBatchWithCost` from the batches screen, on `conn`, which the caller
/// holds in a transaction: the counts as a batch once per request id, costed at the entered
/// purchase total or else estimated for `seller` (none without one). The same request again
/// answers its batch, costed again, which a repeated cost leaves as it was. Unlike [`queued`],
/// nothing is queued for pricing. `purchase` is the body's purchase cost when it is truthy.
pub async fn created(
    conn: &mut PgConnection,
    request_id: &str,
    purchase: Option<&Value>,
    seller: &str,
) -> Result<i32, NotQueued> {
    if purchase.is_some() && seller.is_empty() {
        return Err(conflict(
            "Configure a default shipping seller before recording purchase cost.",
        ));
    }
    let purchase = purchase
        .map(|value| match value {
            Value::Object(fields) => purchase_cost(request_id, seller, fields),
            // Anything else has no `allocationRule` to read.
            _ => Err("Intake purchase cost supports quantity allocation.".to_owned()),
        })
        .transpose()
        .map_err(invalid)?;
    sqlx::query("SELECT pg_advisory_xact_lock(55, 0)")
        .execute(&mut *conn)
        .await?;
    let repeated: Option<(i32, bool)> = sqlx::query_as(
        "SELECT request.batch_number, batch.batch_number IS NOT NULL
        FROM inventory_batch_intake_requests request
        LEFT JOIN inventory_batches batch ON batch.batch_number = request.batch_number
        WHERE request.request_id = $1",
    )
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await?;
    let batch_number = match repeated {
        Some((batch_number, true)) => batch_number,
        Some((batch_number, false)) => {
            return Err(conflict(format!(
                "Request ID {request_id} already created deleted batch {batch_number}"
            )));
        }
        None => create_batch(conn, request_id)
            .await?
            .ok_or_else(|| invalid("No pending inventory items available to batch"))?,
    };
    if let Some(mut cost) = purchase {
        cost.batch_numbers = vec![batch_number];
        purchase_cost::record(conn, &cost)
            .await
            .map_err(unrecorded)?;
    } else if !seller.is_empty() {
        estimate::record_batch(conn, seller, batch_number)
            .await
            .map_err(unrecorded)?;
    }
    Ok(batch_number)
}

/// Queues the counts as a batch (see [`queued`]) in a transaction of its own, against the
/// seller and the pricing configuration as they are now.
pub async fn queue(
    db: &Database,
    request_id: &str,
    queue: &Queue<'_>,
) -> Result<Queued, NotQueued> {
    let (target, config) = tokio::try_join!(target(db), scheduler::saved_config(db))?;
    let mut tx = db.0.begin().await?;
    let queued = queued(&mut tx, request_id, queue, &target, &config).await?;
    tx.commit().await?;
    Ok(queued)
}

/// The seller queued batches are counted and published for.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub seller_key: String,
    /// The seller publication is for, which must be the same to publish.
    pub publication_seller_key: String,
    pub can_publish: bool,
    pub publishing_unavailable_reason: Option<String>,
    pub publication_paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStatus {
    Waiting,
    Planned,
    NeedsReview,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingStatus {
    Queued,
    Pricing,
    Completed,
    Failed,
}

/// A queued batch and how far it got.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub batch_number: i32,
    pub workflow: Workflow,
    pub planning_status: PlanningStatus,
    pub planning_error: Option<String>,
    pub pricing_status: PricingStatus,
    pub pricing_error: Option<String>,
    pub item_count: i64,
    pub quantity: i64,
    pub published_count: i64,
    pub publishing_count: i64,
    pub review_count: i64,
    /// What the batch's cost is recorded as, or none before any is.
    pub recorded_cost_cents: Option<f64>,
    /// Receipt lots no purchase cost covers yet.
    pub uncosted_lot_count: i64,
    /// Whether an entered purchase total, not an estimate, costs it.
    pub has_entered_cost: bool,
    /// The rate its estimate uses; none is the default.
    pub cost_rate: Option<CostRate>,
}

/// Where a queued batch is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    PricingFailed,
    Queued,
    Pricing,
    Published,
    AwaitingPublication,
    NeedsReview,
    Priced,
}

impl Status {
    pub fn word(self) -> &'static str {
        match self {
            Status::PricingFailed => "Pricing failed",
            Status::Queued => "Queued",
            Status::Pricing => "Pricing",
            Status::Published => "Published",
            Status::AwaitingPublication => "Awaiting publication",
            Status::NeedsReview => "Needs review",
            Status::Priced => "Priced; review before publishing",
        }
    }

    fn running(self) -> bool {
        matches!(
            self,
            Status::Queued | Status::Pricing | Status::AwaitingPublication
        )
    }
}

impl Run {
    pub fn status(&self) -> Status {
        match self.pricing_status {
            PricingStatus::Failed => return Status::PricingFailed,
            PricingStatus::Queued => return Status::Queued,
            PricingStatus::Pricing => return Status::Pricing,
            PricingStatus::Completed => {}
        }
        if self.published_count == self.item_count && self.item_count > 0 {
            Status::Published
        } else if self.publishing_count > 0 {
            Status::AwaitingPublication
        } else if self.review_count > 0 || self.planning_status == PlanningStatus::NeedsReview {
            Status::NeedsReview
        } else if self.workflow == Workflow::PriceOnly {
            Status::Priced
        } else if self.planning_status == PlanningStatus::Waiting {
            Status::AwaitingPublication
        } else {
            Status::NeedsReview
        }
    }

    /// Whether it failed, needs review, or reported an error.
    pub fn needs_attention(&self) -> bool {
        matches!(self.status(), Status::PricingFailed | Status::NeedsReview)
            || self.planning_error.is_some()
            || self.pricing_error.is_some()
    }

    /// `Cost $16.50 estimated at 60% of market less $0.50 per card`.
    pub fn cost(&self) -> String {
        let recorded = self.recorded_cost_cents.map(|c| c.round() as i64);
        if self.has_entered_cost {
            return format!("Cost {} entered", dollars(recorded.unwrap_or(0)));
        }
        let rate = match self.cost_rate {
            Some(rate) => rate.describe(),
            None => format!("the default {}", CostRate::DEFAULT.describe()),
        };
        match recorded {
            Some(cents) if self.uncosted_lot_count == 0 => {
                format!("Cost {} estimated at {rate}", dollars(cents))
            }
            _ => format!(
                "Cost not recorded yet; it will be estimated at {rate} once every card has a market price"
            ),
        }
    }
}

/// `2 running, 1 needs review`, or `none running`.
pub fn summary(runs: &[Run]) -> String {
    let running = runs.iter().filter(|r| r.status().running()).count();
    let attention = runs.iter().filter(|r| r.needs_attention()).count();
    let mut parts = Vec::new();
    if running > 0 {
        parts.push(format!("{running} running"));
    }
    if attention > 0 {
        parts.push(format!(
            "{attention} {} review",
            if attention == 1 { "needs" } else { "need" }
        ));
    }
    if parts.is_empty() {
        "none running".to_owned()
    } else {
        parts.join(", ")
    }
}

/// The latest batches and the seller they are for.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Batches {
    pub runs: Vec<Run>,
    pub target: Target,
}

/// The 25 newest runs, newest first, each as `findRecentInventoryIntakeRuns` answers it. A run's
/// review count is its batch's failed or manual-review items once priced, or what is neither
/// published nor publishing when it publishes.
/// `createdAt` is written as Node's `toISOString` writes it.
const RUNS: &str = r#"SELECT to_jsonb(run) FROM (SELECT r.batch_number AS "batchNumber", r.workflow,
    r.planning_status AS "planningStatus", r.planning_error AS "planningError",
    j.status AS "pricingStatus", j.error_message AS "pricingError",
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    items.count AS "itemCount", items.quantity,
    COALESCE(p.published, 0)::int AS "publishedCount",
    COALESCE(p.publishing, 0)::int AS "publishingCount",
    CASE WHEN j.status = 'completed' THEN
      CASE WHEN r.workflow = 'price_only' OR r.planning_status = 'waiting'
        THEN b.manual_review_count + COALESCE(p.failed, 0)
        ELSE GREATEST(0, items.count - COALESCE(p.published, 0) - COALESCE(p.publishing, 0)) END
      ELSE 0 END::int AS "reviewCount",
    cost.cents AS "recordedCostCents", cost.uncosted AS "uncostedLotCount", cost.entered AS "hasEnteredCost",
    CASE WHEN rate.batch_number IS NOT NULL THEN jsonb_build_object(
      'marketRate', rate.market_rate::float8,
      'perUnitDeductionCents', rate.per_unit_deduction_cents) END AS "costRate"
    FROM (SELECT * FROM inventory_intake_runs ORDER BY created_at DESC LIMIT 25) r
    JOIN inventory_batches b ON b.batch_number = r.batch_number
    LEFT JOIN inventory_batch_estimated_cost_rates rate ON rate.batch_number = r.batch_number
    CROSS JOIN LATERAL (SELECT SUM(allocation.allocated_amount_cents)::float8 AS cents,
      COUNT(*) FILTER (WHERE ownership.receipt_id IS NULL)::int AS uncosted,
      COALESCE(bool_or(series.purchase_reference <> 'estimated:batch-' || r.batch_number), FALSE) AS entered
      FROM inventory_receipt_batch_links link
      LEFT JOIN inventory_purchase_receipt_ownership ownership ON ownership.receipt_id = link.receipt_id
      LEFT JOIN inventory_purchase_cost_series series ON series.id = ownership.series_id
      LEFT JOIN LATERAL (SELECT entry.id FROM inventory_purchase_cost_entries entry
        WHERE entry.series_id = ownership.series_id ORDER BY entry.sequence DESC LIMIT 1) current ON TRUE
      LEFT JOIN inventory_purchase_cost_allocations allocation
        ON allocation.entry_id = current.id AND allocation.receipt_id = link.receipt_id
      WHERE link.batch_number = r.batch_number) cost
    JOIN LATERAL (SELECT * FROM inventory_batch_pricing_jobs WHERE batch_number = r.batch_number ORDER BY id DESC LIMIT 1) j ON TRUE
    CROSS JOIN LATERAL (SELECT COUNT(*)::int AS count, COALESCE(SUM(add_to_quantity), 0)::int AS quantity
      FROM inventory_batch_items WHERE batch_number = r.batch_number) items
    LEFT JOIN LATERAL (SELECT
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status = 'published' AND i.quantity_delta > 0) AS published,
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status = 'planned' AND p.status IN ('planned','staging','staged','publishing')) AS publishing,
      COUNT(DISTINCT i.sku) FILTER (WHERE i.status IN ('failed','ambiguous','manual_review') OR
        (i.status = 'planned' AND p.status IN ('failed','ambiguous','rolled_back'))) AS failed
      FROM inventory_publication_items i JOIN inventory_publications p ON p.id = i.publication_id
      WHERE i.batch_number = r.batch_number AND i.quantity_delta > 0) p ON TRUE) run
    ORDER BY run."createdAt" DESC"#;

/// The 25 newest runs as `findRecentInventoryIntakeRuns` answers them, in its JSON.
pub async fn runs_json(db: impl sqlx::PgExecutor<'_>) -> sqlx::Result<Vec<Value>> {
    sqlx::query_scalar(RUNS).fetch_all(db).await
}

async fn runs(db: impl sqlx::PgExecutor<'_>) -> sqlx::Result<Vec<Run>> {
    runs_json(db)
        .await?
        .into_iter()
        .map(|row| serde_json::from_value(row).map_err(|e| sqlx::Error::Decode(e.into())))
        .collect()
}

/// The seller queued batches are for: the default shipping seller, which may be published for
/// only when it is the publication seller (`getIntakePublicationTarget`).
pub async fn target(db: &Database) -> sqlx::Result<Target> {
    let seller_key = shipping_configuration::default_seller_key(db)
        .await?
        .trim()
        .to_owned();
    let publication_seller_key = continuous_pricing::store::settings(db).await?.seller_key;
    let publishing_unavailable_reason = if seller_key.is_empty() {
        Some("Set a default shipping seller before queuing publication.")
    } else if seller_key != publication_seller_key {
        Some(
            "The publication seller and default shipping seller must match before queuing publication.",
        )
    } else {
        None
    };
    Ok(Target {
        can_publish: publishing_unavailable_reason.is_none(),
        publishing_unavailable_reason: publishing_unavailable_reason.map(str::to_owned),
        publication_paused: publication_configuration::paused(db).await?,
        seller_key,
        publication_seller_key,
    })
}

/// The latest batches and the seller they are for.
pub async fn batches(db: &Database) -> Result<Batches, String> {
    let (runs, target) = tokio::try_join!(runs(&db.0), target(db)).map_err(|e| e.to_string())?;
    Ok(Batches { runs, target })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The runs `.port-logs/intake-runs-seed.sql` adds to the dev database, inside a transaction
    /// rolled back, against Node's read of the same (`.port-logs/intake-runs-node.ts`); and the
    /// target as dev has it.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's read in .port-logs"]
    async fn batches_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Batches = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/intake-runs.node.json").unwrap(),
        )
        .unwrap();
        let seed = std::fs::read_to_string(".port-logs/intake-runs-seed.sql").unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('inventory_batch_pricing_jobs tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(&seed).execute(&mut *tx).await.unwrap();
        let ours = runs(&mut *tx).await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(ours.len(), 25);
        assert_eq!(ours, node.runs);
        assert_eq!(target(&db).await.unwrap(), node.target);
    }

    /// A batch's JSON with what differs between runs named instead: its number (as `label` names
    /// it) and its job's id, and whether each time is set.
    pub(crate) fn untimed(mut batch: serde_json::Value, label: &str) -> serde_json::Value {
        fn times(fields: &mut serde_json::Value) {
            for key in [
                "createdAt",
                "updatedAt",
                "lastPricedAt",
                "startedAt",
                "completedAt",
                "claimExpiresAt",
            ] {
                if let Some(at) = fields.get_mut(key) {
                    *at = serde_json::Value::Bool(!at.is_null());
                }
            }
        }
        times(&mut batch);
        batch["batchNumber"] = label.into();
        if batch["latestJob"].is_object() {
            let job = &mut batch["latestJob"];
            times(job);
            job["batchNumber"] = label.into();
            job["id"] = serde_json::Value::Null;
        }
        batch
    }

    fn cost_of(cost: &serde_json::Value) -> Cost {
        let text = |key: &str| cost[key].as_str().unwrap().to_owned();
        match cost["kind"].as_str().unwrap() {
            "estimate" => Cost::Estimate,
            "rate" => Cost::Rate(CostRate {
                market_rate: read_market_percent(&text("marketPercent")).unwrap(),
                per_unit_deduction_cents: read_per_card_deduction(&text("perCardDeduction"))
                    .unwrap(),
            }),
            _ => Cost::Purchase {
                reference: text("reference"),
                total: text("total"),
                date: cost["date"].as_str().map(str::to_owned),
                estimated: cost["estimated"].as_bool().unwrap(),
            },
        }
    }

    /// Checks each quantity cost's fingerprint against its own batch number, as only it can be
    /// (an estimate's names receipt ids, which differ between runs), then drops the two.
    pub(crate) fn fingerprints_checked(mut captured: serde_json::Value) -> serde_json::Value {
        for batch in captured["batches"].as_array_mut().unwrap() {
            let Some(costs) = batch["costs"].as_array_mut() else {
                continue;
            };
            for cost in costs {
                let fields = cost.as_object_mut().unwrap();
                let fingerprint = fields.remove("fingerprint").unwrap();
                let batch_number = fields.remove("batchNumber").unwrap();
                if fields["rule"] != "quantity" {
                    continue;
                }
                let text = |key: &str| fields[key].as_str().unwrap().to_owned();
                let ours = purchase_cost::request_fingerprint(&PurchaseCost {
                    request_id: String::new(),
                    seller_key: text("seller"),
                    purchase_reference: text("reference"),
                    currency: text("currency"),
                    total_amount_cents: fields["total"].as_i64().unwrap(),
                    provenance: if fields["provenance"] == "estimated" {
                        "estimated"
                    } else {
                        "actual"
                    },
                    source: "intake",
                    allocation_rule: "quantity",
                    batch_numbers: vec![batch_number.as_i64().unwrap() as i32],
                    purchased_at: fields["purchasedAt"].as_str().map(str::to_owned),
                    market_observed_at: None,
                    explicit_allocations: Vec::new(),
                    corrects_entry_id: None,
                    correction_reason: None,
                });
                assert_eq!(fingerprint, ours, "fingerprint of {}", text("request"));
            }
        }
        captured
    }

    /// The cases in `.port-logs/intake-queue-cases.json`, from the counts
    /// `.port-logs/pending-seed.sql` leaves, inside a transaction rolled back (a savepoint each),
    /// against Node's route over the same (`.port-logs/intake-queue-node.ts`): what each request
    /// is answered, and the batches, lots, costs, jobs and runs left.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn queues_as_node_queues() {
        use sqlx::Connection;
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |path: &str| std::fs::read_to_string(path).unwrap();
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&read(".port-logs/intake-queue-cases.json")).unwrap();
        let node: serde_json::Value =
            serde_json::from_str(&read(".port-logs/intake-queue.node.json")).unwrap();
        let seed = read(".port-logs/pending-seed.sql");
        let capture = read(".port-logs/intake-queue-capture.sql");
        let target = target(&db).await.unwrap();
        let config = scheduler::saved_config(&db).await.unwrap();
        assert_eq!(node["seller"], target.seller_key.as_str());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('inventory_batch_pricing_jobs tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(&seed).execute(&mut *tx).await.unwrap();
        let node_cases = node["cases"].as_array().unwrap();
        assert_eq!(cases.len(), node_cases.len());
        for (case, node) in cases.iter().zip(node_cases) {
            let name = case["name"].as_str().unwrap();
            let mut each = tx.begin().await.unwrap();
            if let Some(setup) = case["setup"].as_str() {
                sqlx::raw_sql(setup).execute(&mut *each).await.unwrap();
            }
            let mut batches: Vec<i32> = Vec::new();
            let mut answers = Vec::new();
            let mut bodies = Vec::new();
            for step in case["steps"].as_array().unwrap() {
                let expected: Vec<IntakeQuantity> = match step["expected"].as_array() {
                    Some(counts) => counts
                        .iter()
                        .map(|pair| IntakeQuantity {
                            sku: pair[0].as_i64().unwrap(),
                            quantity: pair[1].as_i64().unwrap(),
                        })
                        .collect(),
                    None => {
                        let rows: Vec<(i64, i64)> = sqlx::query_as(
                            "SELECT sku::int8, quantity::int8 FROM pending_inventory ORDER BY sku",
                        )
                        .fetch_all(&mut *each)
                        .await
                        .unwrap();
                        rows.into_iter()
                            .map(|(sku, quantity)| IntakeQuantity { sku, quantity })
                            .collect()
                    }
                };
                let cost = cost_of(&step["cost"]);
                let seller = step["seller"]
                    .as_str()
                    .unwrap_or(&target.seller_key)
                    .to_owned();
                let request = Queue::entered(
                    serde_json::from_value(step["workflow"].clone()).unwrap(),
                    &cost,
                    &expected,
                    &seller,
                );
                let mut attempt = each.begin().await.unwrap();
                let id = step["request"].as_str().unwrap();
                answers.push(
                    match queued(&mut attempt, id, &request, &target, &config).await {
                        Ok(Queued { batch_number }) => {
                            let body = crate::features::batch_pricer::batch_json::find(
                                &mut attempt,
                                batch_number,
                            )
                            .await
                            .unwrap();
                            bodies.push((batch_number, body.unwrap()));
                            attempt.commit().await.unwrap();
                            if !batches.contains(&batch_number) {
                                batches.push(batch_number);
                            }
                            let label =
                                batches.iter().position(|b| *b == batch_number).unwrap() + 1;
                            serde_json::json!({ "status": 201, "batch": format!("B{label}") })
                        }
                        Err(NotQueued::Refused(why, error)) => {
                            attempt.rollback().await.unwrap();
                            let status = match why {
                                Refusal::Invalid => 400,
                                Refusal::Conflict => 409,
                                other => panic!("{name}: refused as {other:?}"),
                            };
                            serde_json::json!({ "status": status, "error": error })
                        }
                        Err(NotQueued::Unrecorded(error)) => {
                            attempt.rollback().await.unwrap();
                            serde_json::json!({ "status": 500, "error": error })
                        }
                        Err(NotQueued::Failed(why)) => panic!("{name}: {why}"),
                    },
                );
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(serde_json::Value::from(answers), node["answers"], "{name}");
            let node_bodies = node["bodies"].as_array().unwrap();
            assert_eq!(bodies.len(), node_bodies.len(), "{name}");
            for ((number, ours), theirs) in bodies.iter().zip(node_bodies) {
                let label = batches.iter().position(|b| b == number).unwrap() + 1;
                let label = format!("B{label}");
                let ours = crate::api::tests::node_numbers(ours);
                assert_eq!(
                    untimed(ours, &label),
                    untimed(theirs.clone(), &label),
                    "{name}"
                );
            }
            let ours = fingerprints_checked(serde_json::from_str(&captured).unwrap());
            assert_eq!(
                ours,
                fingerprints_checked(node["captured"].clone()),
                "{name}"
            );
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn amounts_and_dates_are_read_as_node_reads_them() {
        assert_eq!(dollars_to_cents(" 12.3 ", "Purchase total"), Ok(1230));
        assert_eq!(
            dollars_to_cents("12.", "Purchase total"),
            Err(
                "Purchase total must be a nonnegative amount with at most two decimal places."
                    .into()
            )
        );
        assert_eq!(
            dollars_to_cents("90071992547409.92", "Purchase total"),
            Err("Purchase total is outside the supported range.".into())
        );
        assert_eq!(
            dollars_to_cents("90071992547409.91", "Purchase total"),
            Ok(crate::features::inventory_economics::details::MAX_SAFE_INTEGER)
        );
        assert_eq!(
            calendar_date(Some(" 2024-02-29 ")),
            Ok(Some("2024-02-29".into()))
        );
        assert_eq!(calendar_date(Some("  ")), Ok(None));
        assert!(calendar_date(Some("2023-02-29")).is_err());
        assert!(calendar_date(Some("0099-01-01")).is_err());
        assert!(calendar_date(Some("2024-2-09")).is_err());
    }

    #[test]
    fn a_rate_is_written_as_entered() {
        assert_eq!(
            CostRate::DEFAULT.describe(),
            "75% of market less $0.30 per card"
        );
        let rate = CostRate {
            market_rate: 0.605,
            per_unit_deduction_cents: 50,
        };
        assert_eq!(rate.market_percent(), "60.5");
        let rate = CostRate {
            market_rate: 0.3333,
            per_unit_deduction_cents: 5,
        };
        assert_eq!(rate.describe(), "33.33% of market less $0.05 per card");
    }

    #[test]
    fn a_rate_is_read_as_the_node_app_reads_it() {
        assert_eq!(read_market_percent("60.5"), Ok(0.605));
        assert_eq!(read_market_percent(" 100 "), Ok(1.0));
        assert!(read_market_percent("100.01").is_err());
        assert!(read_market_percent("1.234").is_err());
        assert!(read_market_percent("-1").is_err());
        assert_eq!(read_per_card_deduction("0.3"), Ok(30));
        assert_eq!(read_per_card_deduction("100"), Ok(10_000));
        assert_eq!(
            read_per_card_deduction("100.01"),
            Err("Amount less per card must be at most $100.00.".into())
        );
    }

    #[test]
    fn dollars_keep_their_sign() {
        assert_eq!(dollars(1650), "$16.50");
        assert_eq!(dollars(-20), "-$0.20");
    }

    #[test]
    fn a_purchase_total_needs_a_reference_and_an_amount() {
        let input = QueueInput {
            cost: CostMethod::PurchaseTotal,
            purchase_total: "abc".into(),
            ..QueueInput::new()
        };
        let errors = input.read_cost().unwrap_err();
        let f = QueueInput::FIELDS;
        assert!(errors.has(f.purchase_reference) && errors.has(f.purchase_total));
        let input = QueueInput {
            cost: CostMethod::PurchaseTotal,
            purchase_reference: "Lot 7".into(),
            purchase_total: "$120.5".into(),
            ..QueueInput::new()
        };
        assert_eq!(
            input.read_cost(),
            Ok(Cost::Purchase {
                reference: "Lot 7".into(),
                total: "120.5".into(),
                date: None,
                estimated: false
            })
        );
    }

    #[test]
    fn after_queuing_a_rate_stays_and_a_purchase_clears() {
        let rate = QueueInput {
            cost: CostMethod::CostRate,
            market_percent: "60".into(),
            ..QueueInput::new()
        };
        assert_eq!(rate.after_queue().cost, CostMethod::CostRate);
        assert_eq!(rate.after_queue().market_percent, "60");
        let purchase = QueueInput {
            cost: CostMethod::PurchaseTotal,
            purchase_reference: "Lot".into(),
            ..QueueInput::new()
        };
        assert_eq!(purchase.after_queue().cost, CostMethod::Estimate);
        assert_eq!(purchase.after_queue().purchase_reference, "");
    }

    #[test]
    fn rate_fields_not_sent_are_drawn_with_the_default_rate() {
        let sent = QueueInput {
            cost: CostMethod::Estimate,
            ..QueueInput::default()
        }
        .filled();
        assert_eq!(
            (
                sent.market_percent.as_str(),
                sent.per_card_deduction.as_str()
            ),
            ("75", "0.30")
        );
    }

    #[test]
    fn the_request_is_saved_as_the_node_app_saves_it() {
        let expected = [
            IntakeQuantity {
                sku: 5,
                quantity: 1,
            },
            IntakeQuantity {
                sku: 2,
                quantity: 3,
            },
        ];
        let cost = Cost::Rate(CostRate {
            market_rate: 0.6,
            per_unit_deduction_cents: 50,
        });
        let q = Queue::entered(Workflow::PriceOnly, &cost, &expected, "abc");
        assert_eq!(
            details(&q),
            serde_json::json!({
                "workflow": "price_only",
                "purchaseCost": null,
                "estimatedCostRate": { "marketPercent": "60", "perCardDeduction": "0.50" },
                "expectedInventory": [{ "sku": 2, "quantity": 3 }, { "sku": 5, "quantity": 1 }],
                "expectedSellerKey": "abc"
            })
        );
        let cost = Cost::Purchase {
            reference: "Lot".into(),
            total: "12".into(),
            date: Some("2026-10-01".into()),
            estimated: true,
        };
        let q = Queue::entered(Workflow::Publish, &cost, &expected, "abc");
        let json = details(&q);
        assert_eq!(json.get("estimatedCostRate"), None);
        assert_eq!(
            json["purchaseCost"],
            serde_json::json!({
                "purchaseReference": "Lot",
                "totalAmount": "12",
                "provenance": "estimated",
                "allocationRule": "quantity",
                "purchasedAt": "2026-10-01",
                "currency": "USD"
            })
        );
    }

    #[test]
    fn the_fingerprint_follows_the_counts_not_their_order() {
        let a: HashMap<i32, i32> = [(1, 2), (3, 4)].into();
        let b: HashMap<i32, i32> = [(3, 4), (1, 2)].into();
        let c: HashMap<i32, i32> = [(1, 2), (3, 5)].into();
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    fn run(pricing: PricingStatus, published: i64, items: i64) -> Run {
        Run {
            batch_number: 1,
            workflow: Workflow::PriceOnly,
            planning_status: PlanningStatus::Planned,
            planning_error: None,
            pricing_status: pricing,
            pricing_error: None,
            item_count: items,
            quantity: items,
            published_count: published,
            publishing_count: 0,
            review_count: 0,
            recorded_cost_cents: None,
            uncosted_lot_count: 0,
            has_entered_cost: false,
            cost_rate: None,
        }
    }

    #[test]
    fn statuses_and_the_summary_match_the_react_screen() {
        assert_eq!(run(PricingStatus::Pricing, 0, 3).status(), Status::Pricing);
        assert_eq!(
            run(PricingStatus::Completed, 3, 3).status(),
            Status::Published
        );
        assert_eq!(run(PricingStatus::Completed, 0, 3).status(), Status::Priced);
        let runs = [
            run(PricingStatus::Queued, 0, 1),
            run(PricingStatus::Failed, 0, 1),
        ];
        assert_eq!(summary(&runs), "1 running, 1 needs review");
        assert_eq!(summary(&[]), "none running");
    }
}
