//! `/api/inventory-economics`: the default shipping seller's economics workspace (`GET`), and the
//! operator's actions (`POST`, a JSON object naming its `action`) as the Node route answered
//! them: the estimate backfill (`record_estimated_purchase_costs`) and a batch's estimate rate
//! (`change_estimated_cost_rate`); recording a purchase cost, funding adjustment or order expense;
//! finding the lots a purchase would split across; and importing purchase costs from a CSV. Each
//! recording answers the entry and the workspace after it. Every failure is a 409 saying why, as
//! Node's catch-all answered it, save an unknown action (400) and an oversized CSV (413).
//!
//! Where it differs from Node: a body that is not JSON is refused in serde_json's words, not V8's;
//! a batch number past Postgres's `integer` is refused before the request id is looked up (Node
//! met it at the lots query, after); and an explicit allocation's receipt id past JavaScript's
//! safe integers is refused as not a unique receipt selection (Node, after its other checks, as
//! not naming the batches' receipts).
use corten::{
    Api, JsonResponse, Prefix,
    axum::{body::to_bytes, extract::Request, http::StatusCode},
    prelude::*,
};
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    details::{
        MAX_SAFE_INTEGER, calendar_date, distinct, instant, js_dollars, js_length,
        postgres_integer, required_text,
    },
    estimate::{self, ExplicitAllocation, PurchaseCost},
    expense::{self, BASES, EXPENSE_TYPES, Expense},
    funding::{self, ADJUSTMENT_TYPES, Funding},
    purchase_cost, purchase_cost_import,
    series::{NotRecorded, Saved, failed},
    workspace_json,
};
use crate::{
    api::{self, js_string, js_to_number},
    app::Shared,
    database::Database,
    features::{inventory_intake::queue::cost_rate, shipping_configuration},
};

/// The largest body read before it is answered.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

const NO_SELLER: &str = "Configure a default shipping seller before recording inventory economics.";

const PROVENANCES: [&str; 2] = ["actual", "estimated"];
const ALLOCATION_RULES: [&str; 3] = ["quantity", "frozen_market", "explicit"];

#[derive(Route)]
#[route("/api/inventory-economics")]
pub struct EconomicsApi;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<EconomicsApi>(
        get(show)
            .post(act)
            .put(not_allowed)
            .patch(not_allowed)
            .delete(not_allowed)
            .with_state(shared.clone()),
    )
}

/// `configuredSeller`: the default shipping seller, or why there is none.
async fn seller(db: &Database) -> Result<String, String> {
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| e.to_string())?;
    let seller = seller.trim();
    if seller.is_empty() {
        return Err(NO_SELLER.to_owned());
    }
    Ok(seller.to_owned())
}

/// The workspace; a 500 saying why when it cannot be read.
async fn show(State(db): State<Database>) -> JsonResponse {
    let workspace = match seller(&db).await {
        Ok(seller) => workspace_json::read(&db, &seller).await,
        Err(message) => Err(message),
    };
    match workspace {
        Ok(workspace) => api::node_json(&json!({ "workspace": workspace })),
        Err(message) => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

/// Any write but a post: Node's action.
async fn not_allowed() -> JsonResponse {
    api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.")
}

/// Why an action was not answered: its status (409 unless said) and Node's words.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Refused(pub StatusCode, pub String);

impl From<String> for Refused {
    fn from(message: String) -> Self {
        Refused(StatusCode::CONFLICT, message)
    }
}

impl From<NotRecorded> for Refused {
    fn from(not: NotRecorded) -> Self {
        String::from(not).into()
    }
}

/// The action's answer, or why not.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let Ok(bytes) = to_bytes(request.into_body(), MAX_BODY_BYTES).await else {
        return api::error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large.");
    };
    let answer = match seller(&db).await {
        Ok(seller) => answered(&db, &seller, &bytes).await,
        Err(message) => Err(message.into()),
    };
    match answer {
        Ok(answer) => api::node_json(&answer),
        Err(Refused(status, message)) => api::error(status, message),
    }
}

async fn answered(db: &Database, seller: &str, body: &[u8]) -> Result<Value, Refused> {
    let payload = payload(body)?;
    if let Some(payload) = payload.as_object().filter(|p| {
        matches!(
            p.get("action").and_then(Value::as_str),
            Some("record_estimated_purchase_costs" | "change_estimated_cost_rate")
        )
    }) {
        return Ok(estimated(db, seller, payload).await?);
    }
    let mut conn = db.0.acquire().await.map_err(failed)?;
    recorded(&mut conn, seller, &payload).await
}

/// `await request.json()`, and the `payload.action` read that fails on `null`.
pub(crate) fn payload(body: &[u8]) -> Result<Value, Refused> {
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| Refused::from(format!("SyntaxError: {e}")))?;
    if payload.is_null() {
        return Err("Cannot read properties of null (reading 'action')"
            .to_owned()
            .into());
    }
    Ok(payload)
}

/// A recording action (or finding allocation targets) on `conn`: each recording in a
/// transaction of its own, answered with the workspace after it.
pub(crate) async fn recorded(
    conn: &mut PgConnection,
    seller: &str,
    payload: &Value,
) -> Result<Value, Refused> {
    let field = |key: &str| payload.get(key);
    let request_id = text(field("requestId"), "Request ID")?;
    let usd = Value::from("USD");
    let currency = text(
        Some(field("currency").filter(|c| !c.is_null()).unwrap_or(&usd)),
        "Currency",
    )?;
    let entry = match field("action").and_then(Value::as_str) {
        Some("find_purchase_allocation_targets") => {
            let batches = batch_numbers(field("batchNumbers").unwrap_or(&Value::Null))?;
            let (targets, complete) =
                purchase_cost::allocation_targets(conn, seller, &batches).await?;
            return Ok(json!({
                "purchaseAllocationTargets": targets,
                "purchaseAllocationTargetsComplete": complete,
            }));
        }
        Some("import_purchase_costs") => {
            let csv = text(field("csvText"), "Purchase cost CSV")?;
            if csv.len() > purchase_cost_import::MAX_CSV_BYTES {
                return Err(Refused(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Purchase cost CSV exceeds 256 KB.".to_owned(),
                ));
            }
            let result = purchase_cost_import::import(conn, seller, &csv).await?;
            let workspace = workspace_json::read_on(conn, seller).await?;
            return Ok(json!({ "result": result, "workspace": workspace }));
        }
        Some("record_purchase_cost") => {
            Entry::PurchaseCost(manual_purchase_cost(payload, request_id, seller, currency)?)
        }
        Some("record_funding") => {
            Entry::Funding(funding_of(payload, request_id, seller, currency)?)
        }
        Some("record_expense") => {
            Entry::Expense(expense_of(payload, request_id, seller, currency)?)
        }
        _ => {
            return Err(Refused(
                StatusCode::BAD_REQUEST,
                "Unknown inventory economics action.".to_owned(),
            ));
        }
    };
    let mut tx = conn.begin().await.map_err(failed)?;
    let saved = entry.record(&mut tx).await?;
    tx.commit().await.map_err(failed)?;
    let workspace = workspace_json::read_on(conn, seller).await?;
    Ok(json!({ "result": saved.node_json(), "workspace": workspace }))
}

/// Evidence an action records.
enum Entry {
    PurchaseCost(PurchaseCost),
    Funding(Funding),
    Expense(Expense),
}

impl Entry {
    async fn record(&self, conn: &mut PgConnection) -> Result<Saved, NotRecorded> {
        match self {
            Entry::PurchaseCost(cost) => purchase_cost::record(conn, cost).await,
            Entry::Funding(funding) => funding::record(conn, funding).await,
            Entry::Expense(expense) => expense::record(conn, expense).await,
        }
    }
}

/// `text`: trimmed text, or "`label` is required."
fn text(value: Option<&Value>, label: &str) -> Result<String, String> {
    match value.and_then(Value::as_str).map(api::js_trim) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => Err(format!("{label} is required.")),
    }
}

/// `choice`: one of `values`, exactly as sent.
fn choice(
    value: Option<&Value>,
    values: &[&'static str],
    label: &str,
) -> Result<&'static str, String> {
    let sent = value.and_then(Value::as_str);
    values
        .iter()
        .find(|v| Some(**v) == sent)
        .copied()
        .ok_or_else(|| format!("{label} is invalid."))
}

/// `optionalText`: trimmed text, none when blank or not text.
fn optional_text(value: Option<&Value>) -> Option<String> {
    let text = api::js_trim(value?.as_str()?);
    (!text.is_empty()).then(|| text.to_owned())
}

/// `stringArray`: a list of text.
fn string_array(value: Option<&Value>, label: &str) -> Result<Vec<String>, String> {
    let invalid = || format!("{label} is invalid.");
    value
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .map(|item| item.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect()
}

/// The `record_purchase_cost` action's purchase, read as the route reads it and then as
/// `normalizePurchaseCostDetails` and `recordPurchaseCost` check it before writing.
fn manual_purchase_cost(
    payload: &Value,
    request_id: String,
    seller: &str,
    currency: String,
) -> Result<PurchaseCost, String> {
    let field = |key: &str| payload.get(key);
    let allocation_rule = choice(
        field("allocationRule"),
        &ALLOCATION_RULES,
        "Allocation rule",
    )?;
    let purchase_reference = text(field("purchaseReference"), "Purchase reference")?;
    let total_amount_cents = js_dollars(field("totalAmount"), "Purchase total")?;
    let provenance = choice(field("provenance"), &PROVENANCES, "Provenance")?;
    let batches = batch_numbers(field("batchNumbers").unwrap_or(&Value::Null))?;
    let purchased_at = optional_text(field("purchasedAt"));
    let frozen = allocation_rule == "frozen_market";
    let market_observed_at = frozen
        .then(|| optional_text(field("marketObservedAt")))
        .flatten();
    let corrects_entry_id = optional_text(field("correctsEntryId"));
    let correction_reason = optional_text(field("correctionReason"));
    let explicit_allocations = if allocation_rule == "explicit" {
        explicit_allocations(field("explicitAllocations"))?
    } else {
        Vec::new()
    };

    let currency = required_text(&currency, "Currency")?.to_uppercase();
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("Currency must be a three-letter code.".to_owned());
    }
    let purchased_at = calendar_date(purchased_at.as_deref())?;
    let market_observed_at = if frozen {
        let instant = instant(market_observed_at.as_deref())?;
        Some(instant.ok_or("Frozen market allocation requires a market evidence instant.")?)
    } else {
        None
    };
    for (text, label) in [
        (&corrects_entry_id, "Corrected entry"),
        (&correction_reason, "Correction reason"),
    ] {
        if text.as_deref().is_some_and(|t| js_length(t) > 200) {
            return Err(format!("{label} is limited to 200 characters."));
        }
    }
    if corrects_entry_id.is_some() != correction_reason.is_some() {
        return Err("A correction requires both the current entry and a reason.".to_owned());
    }
    let request_id = required_text(&request_id, "Request ID")?;
    let seller_key = required_text(seller, "Seller key")?;
    let purchase_reference = required_text(&purchase_reference, "Purchase reference")?;
    let batches = distinct(&batches);
    if batches.is_empty() || batches.len() > 100 {
        return Err("Purchase costs require 1 to 100 positive batch numbers.".to_owned());
    }
    Ok(PurchaseCost {
        request_id,
        seller_key,
        purchase_reference,
        currency,
        total_amount_cents,
        provenance,
        source: "manual",
        allocation_rule,
        batch_numbers: batches
            .into_iter()
            .map(postgres_integer)
            .collect::<Result<_, _>>()?,
        purchased_at,
        market_observed_at,
        explicit_allocations,
        corrects_entry_id,
        correction_reason,
    })
}

/// `parseExplicitAllocations`: an amount for each receipt, once each, as whole cents
/// (`amountCents`) or dollars (`amount`).
fn explicit_allocations(value: Option<&Value>) -> Result<Vec<ExplicitAllocation>, String> {
    let items = match value {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => {
            return Err(
                "Explicit allocation requires an amount for every selected receipt.".to_owned(),
            );
        }
    };
    let mut seen: Vec<i64> = Vec::with_capacity(items.len());
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let n = index + 1;
            if !matches!(item, Value::Object(_) | Value::Array(_)) {
                return Err(format!("Explicit allocation {n} is invalid."));
            }
            let receipt = item.get("receiptId").map_or(f64::NAN, js_to_number);
            let unique = || "Explicit allocations require unique receipt selections.".to_owned();
            if !receipt.is_finite()
                || receipt.fract() != 0.0
                || receipt <= 0.0
                || receipt > MAX_SAFE_INTEGER as f64
            {
                return Err(unique());
            }
            let receipt_id = receipt as i64;
            if seen.contains(&receipt_id) {
                return Err(unique());
            }
            seen.push(receipt_id);
            let amount = match item.get("amountCents") {
                None => Value::from(js_dollars(
                    item.get("amount"),
                    &format!("Receipt allocation {n}"),
                )?),
                Some(cents) => cents.clone(),
            };
            let amount_cents = amount
                .as_f64()
                .filter(|c| c.fract() == 0.0 && *c >= 0.0 && *c <= MAX_SAFE_INTEGER as f64)
                .ok_or_else(|| {
                    format!("Receipt allocation {n} must be nonnegative whole cents.")
                })?;
            Ok(ExplicitAllocation {
                receipt_id,
                amount_cents: amount_cents as i64,
            })
        })
        .collect()
}

/// The `record_funding` action's adjustment, read as the route reads it.
fn funding_of(
    payload: &Value,
    request_id: String,
    seller: &str,
    currency: String,
) -> Result<Funding, String> {
    let field = |key: &str| payload.get(key);
    Ok(Funding {
        request_id,
        seller_key: seller.to_owned(),
        currency,
        adjustment_reference: text(field("adjustmentReference"), "Adjustment reference")?,
        adjustment_type: choice(
            field("adjustmentType"),
            &ADJUSTMENT_TYPES,
            "Adjustment type",
        )?,
        amount_cents: js_dollars(field("amount"), "Funding amount")?,
        provenance: choice(field("provenance"), &PROVENANCES, "Provenance")?,
        effective_at: text(field("effectiveAt"), "Effective date")?,
        purchase_reference: optional_text(field("purchaseReference")),
        corrects_entry_id: optional_text(field("correctsEntryId")),
        correction_reason: optional_text(field("correctionReason")),
    })
}

/// The `record_expense` action's expense, read as the route reads it.
fn expense_of(
    payload: &Value,
    request_id: String,
    seller: &str,
    currency: String,
) -> Result<Expense, String> {
    let field = |key: &str| payload.get(key);
    Ok(Expense {
        request_id,
        seller_key: seller.to_owned(),
        currency,
        expense_reference: text(field("expenseReference"), "Expense reference")?,
        expense_type: choice(field("expenseType"), &EXPENSE_TYPES, "Expense type")?,
        amount_cents: js_dollars(field("amount"), "Expense amount")?,
        provenance: choice(field("provenance"), &PROVENANCES, "Provenance")?,
        order_numbers: string_array(field("orderNumbers"), "Order numbers")?,
        expense_at: text(field("expenseAt"), "Expense date")?,
        basis: choice(field("basis"), &BASES, "Expense basis")?,
        corrects_entry_id: optional_text(field("correctsEntryId")),
        correction_reason: optional_text(field("correctionReason")),
    })
}

/// The estimate action's answer: the run, and for the backfill the workspace after it.
async fn estimated(
    db: &Database,
    seller: &str,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    if payload.get("action").and_then(Value::as_str) == Some("record_estimated_purchase_costs") {
        let batches: Option<Vec<i32>> = payload
            .get("batchNumbers")
            .map(|value| {
                batch_numbers(value)?
                    .into_iter()
                    .map(postgres_integer)
                    .collect()
            })
            .transpose()?;
        let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
        let run = estimate::record_estimates(&mut conn, seller, batches.as_deref())
            .await
            .map_err(String::from)?;
        drop(conn);
        let workspace = workspace_json::read(db, seller).await?;
        return Ok(json!({ "result": run.node_json(), "workspace": workspace }));
    }
    // A batch number left out is `String(undefined)`, which is not a number either.
    let batch = payload
        .get("batchNumber")
        .cloned()
        .unwrap_or_else(|| "undefined".into());
    let [batch] = batch_numbers(&Value::Array(vec![batch]))?[..] else {
        unreachable!("one value is one batch number");
    };
    let rate = cost_rate(payload)?;
    let run = estimate::change_rate(db, postgres_integer(batch)?, rate).await?;
    Ok(json!({ "result": run.node_json() }))
}

/// `parseBatchNumbers`: a list, or text split at `|`, `;` or `,`, of positive whole numbers.
fn batch_numbers(value: &Value) -> Result<Vec<f64>, String> {
    let values: Vec<String> = match value {
        Value::Array(items) => items.iter().map(js_string).collect(),
        Value::String(text) => text.split(['|', ';', ',']).map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let numbers: Vec<f64> = values
        .iter()
        .map(|text| api::js_number(api::js_trim(text)).unwrap_or(f64::NAN))
        .collect();
    if numbers.is_empty()
        || numbers
            .iter()
            .any(|n| !n.is_finite() || n.fract() != 0.0 || *n <= 0.0)
    {
        return Err("Batch numbers must be positive integers.".to_owned());
    }
    Ok(numbers)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn batch_numbers_are_read_as_node_reads_them() {
        assert_eq!(
            batch_numbers(&json!("206; 2733|672")),
            Ok(vec![206.0, 2733.0, 672.0])
        );
        assert_eq!(
            batch_numbers(&json!([206, "0x10", [5], 7.0])),
            Ok(vec![206.0, 16.0, 5.0, 7.0])
        );
        let refused = Err("Batch numbers must be positive integers.".to_owned());
        for value in [
            json!([]),
            json!(""),
            json!([0]),
            json!([1.5]),
            json!([null]),
            json!(5),
            json!([true]),
            json!([{}]),
            json!("1,,2"),
        ] {
            assert_eq!(batch_numbers(&value), refused, "{value}");
        }
        assert_eq!(postgres_integer(2_147_483_647.0), Ok(i32::MAX));
        assert_eq!(
            postgres_integer(3e9),
            Err("value \"3000000000\" is out of range for type integer".to_owned())
        );
    }

    #[test]
    fn explicit_allocations_are_read_as_node_reads_them() {
        assert_eq!(
            explicit_allocations(Some(&json!([
                { "receiptId": "12", "amount": " 1.50 " },
                { "receiptId": [3], "amountCents": 2.0 },
                { "receiptId": true, "amountCents": 0 },
            ]))),
            Ok(vec![
                ExplicitAllocation {
                    receipt_id: 12,
                    amount_cents: 150
                },
                ExplicitAllocation {
                    receipt_id: 3,
                    amount_cents: 2
                },
                ExplicitAllocation {
                    receipt_id: 1,
                    amount_cents: 0
                },
            ])
        );
        for (value, refusal) in [
            (
                json!([]),
                "Explicit allocation requires an amount for every selected receipt.",
            ),
            (json!([null]), "Explicit allocation 1 is invalid."),
            (
                json!([[]]),
                "Explicit allocations require unique receipt selections.",
            ),
            (
                json!([{ "receiptId": 3, "amountCents": 1 }, { "receiptId": "3", "amountCents": 1 }]),
                "Explicit allocations require unique receipt selections.",
            ),
            (
                json!([{ "receiptId": 3, "amountCents": -1 }]),
                "Receipt allocation 1 must be nonnegative whole cents.",
            ),
            (
                json!([{ "receiptId": 3, "amountCents": null }]),
                "Receipt allocation 1 must be nonnegative whole cents.",
            ),
            (
                json!([{ "receiptId": 3, "amount": 5 }]),
                "Receipt allocation 1 must be a nonnegative amount with at most two decimal places.",
            ),
        ] {
            assert_eq!(
                explicit_allocations(Some(&value)),
                Err(refusal.to_owned()),
                "{value}"
            );
        }
    }

    #[test]
    fn a_body_is_read_as_node_reads_it() {
        assert_eq!(
            payload(b"null"),
            Err(Refused(
                StatusCode::CONFLICT,
                "Cannot read properties of null (reading 'action')".to_owned()
            ))
        );
        assert!(payload(b"{").unwrap_err().1.starts_with("SyntaxError: "));
        assert_eq!(payload(b"[]"), Ok(json!([])));
        assert_eq!(text(Some(&json!(" x ")), "Request ID"), Ok("x".to_owned()));
        assert_eq!(
            text(Some(&json!(5)), "Request ID"),
            Err("Request ID is required.".to_owned())
        );
        assert_eq!(
            choice(Some(&json!(" actual")), &PROVENANCES, "Provenance"),
            Err("Provenance is invalid.".to_owned())
        );
    }

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts inventory-economics`): the
    /// workspace, and each estimate action's refusals before it writes. What a backfill or a rate
    /// change writes is compared with Node's in `estimate::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-economics", &["/workspace/generatedAt"])
            .await;
    }
}
