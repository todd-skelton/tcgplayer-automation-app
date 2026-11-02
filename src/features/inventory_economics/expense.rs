//! Recording an order expense (fulfillment, a refund's settlement, or anything else an order cost
//! beyond what its sale recorded), ported from `inventoryEconomicsRepository.recordOrderExpense`.
//! Recorded once per request, corrected by later entries of its series, as every economics ledger
//! is (`super::series`). A refund settlement is tied to the order's financial records as they were
//! when it was recorded.
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    details::{MAX_SAFE_INTEGER, currency, ledger_date, required_text},
    ledger::fingerprint::{financial, sha256_hex, stable_json},
    series::{self, Ledger, NotRecorded, Saved, failed},
};
use crate::api::js_trim;

/// The expenses the ledger takes.
pub const EXPENSE_TYPES: [&str; 3] = ["fulfillment", "refund_settlement", "other"];

/// What a refund settlement's amount is measured against.
pub const BASES: [&str; 3] = [
    "additional_expense",
    "original_net_refund_adjustment",
    "already_adjusted_net",
];

/// What Node's `recordOrderExpense` is given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expense {
    pub request_id: String,
    pub seller_key: String,
    pub expense_reference: String,
    pub currency: String,
    pub expense_type: &'static str,
    pub amount_cents: i64,
    pub provenance: &'static str,
    pub order_numbers: Vec<String>,
    /// `YYYY-MM-DD`.
    pub expense_at: String,
    pub basis: &'static str,
    pub corrects_entry_id: Option<String>,
    pub correction_reason: Option<String>,
}

/// An order the expense names, as recorded now.
#[derive(sqlx::FromRow)]
struct KnownOrder {
    currency: String,
    transaction_evidence: Option<Value>,
    refund_evidence: Option<Value>,
}

/// The order numbers trimmed, without blanks or repeats, in JavaScript's default `sort` order
/// (by UTF-16 unit).
fn order_numbers(numbers: &[String]) -> Vec<String> {
    let mut numbers: Vec<String> = numbers
        .iter()
        .map(|n| js_trim(n).to_owned())
        .filter(|n| !n.is_empty())
        .collect();
    numbers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    numbers.dedup();
    numbers
}

/// What a checked request says (with its order's financial fingerprint, for a refund
/// settlement), as Node fingerprints it to tell a repeat from a reuse of its id.
pub fn request_fingerprint(
    expense: &Expense,
    financial_source_fingerprint: Option<&str>,
) -> String {
    sha256_hex(&stable_json(&json!({
        "sellerKey": expense.seller_key,
        "reference": expense.expense_reference,
        "currency": expense.currency,
        "expenseType": expense.expense_type,
        "amountCents": expense.amount_cents,
        "provenance": expense.provenance,
        "orderNumbers": expense.order_numbers,
        "expenseAt": expense.expense_at,
        "basis": expense.basis,
        "financialSourceFingerprint": financial_source_fingerprint,
        "correctsEntryId": expense.corrects_entry_id,
        "correctionReason": expense.correction_reason.as_deref().map(js_trim),
    })))
}

/// Records `expense` on `conn`, which the caller holds in a transaction.
pub async fn record(conn: &mut PgConnection, expense: &Expense) -> Result<Saved, NotRecorded> {
    let request_id = required_text(&expense.request_id, "Request ID")?;
    let seller_key = required_text(&expense.seller_key, "Seller key")?;
    let reference = required_text(&expense.expense_reference, "Expense reference")?;
    let currency = currency(&expense.currency)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&expense.amount_cents) {
        return Err("Expense amount must be nonnegative whole cents.".into());
    }
    let order_numbers = order_numbers(&expense.order_numbers);
    if order_numbers.is_empty() || order_numbers.len() > 100 {
        return Err("An expense must name 1 to 100 orders.".into());
    }
    let refund_settlement = expense.expense_type == "refund_settlement";
    if refund_settlement && order_numbers.len() != 1 {
        return Err("A refund settlement must identify exactly one order.".into());
    }
    let expense_at = ledger_date(&expense.expense_at, "Expense date")?;
    let known: Vec<KnownOrder> = sqlx::query_as(
        "SELECT orders.currency::text AS currency,orders.transaction_evidence,revision.refund_evidence
         FROM seller_orders orders
         JOIN seller_order_revisions revision ON revision.order_id=orders.id AND revision.revision_number=orders.source_revision
         WHERE orders.seller_key=$1 AND orders.order_number=ANY($2::text[]) FOR SHARE OF orders,revision",
    )
    .bind(&seller_key)
    .bind(&order_numbers)
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    if known.len() != order_numbers.len() {
        return Err("Every expense order must belong to the configured seller.".into());
    }
    if known.iter().any(|order| order.currency != currency) {
        return Err("Expense currency must match every selected order.".into());
    }
    let financial_source_fingerprint = refund_settlement.then(|| {
        let order = &known[0];
        financial(
            order.transaction_evidence.as_ref().unwrap_or(&Value::Null),
            order.refund_evidence.as_ref().unwrap_or(&Value::Null),
        )
    });
    let expense = &Expense {
        request_id,
        seller_key,
        expense_reference: reference,
        currency,
        order_numbers,
        expense_at,
        ..expense.clone()
    };
    let fingerprint = request_fingerprint(expense, financial_source_fingerprint.as_deref());
    let (request_id, seller_key, reference, currency) = (
        &expense.request_id,
        &expense.seller_key,
        &expense.expense_reference,
        &expense.currency,
    );
    let (order_numbers, expense_at) = (&expense.order_numbers, &expense.expense_at);
    let ledger = Ledger::OrderExpenses;
    if let Some(saved) = series::repeated(conn, ledger, request_id, &fingerprint).await? {
        return Ok(saved);
    }
    if !refund_settlement && expense.basis != "additional_expense" {
        return Err("Only refund settlements may specify a net basis.".into());
    }
    let series = series::lock_series(conn, ledger, seller_key, reference, currency).await?;
    let correction = series::next_correction(
        conn,
        ledger,
        &series,
        expense.corrects_entry_id.as_deref(),
        expense.correction_reason.as_deref(),
    )
    .await?;
    let entry_id: String = sqlx::query_scalar(
        "INSERT INTO inventory_order_expense_entries
          (series_id,request_id,request_fingerprint,sequence,expense_type,amount_cents,provenance,order_numbers,
           expense_at,basis,financial_source_fingerprint,corrects_entry_id,correction_reason)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::bigint,$13) RETURNING id::text",
    )
    .bind(&series)
    .bind(request_id)
    .bind(&fingerprint)
    .bind(correction.sequence)
    .bind(expense.expense_type)
    .bind(expense.amount_cents)
    .bind(expense.provenance)
    .bind(order_numbers)
    .bind(expense_at)
    .bind(expense.basis)
    .bind(&financial_source_fingerprint)
    .bind(&correction.corrects_entry_id)
    .bind(&correction.reason)
    .fetch_one(&mut *conn)
    .await
    .map_err(failed)?;
    Ok(Saved {
        entry_id,
        repeated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `fingerprint` of the same (`.port-logs/fp-check.ts`).
    #[test]
    fn fingerprints_a_correction_as_node_does() {
        let expense = Expense {
            request_id: "r".into(),
            seller_key: "seller".into(),
            expense_reference: "port-exp-fix".into(),
            currency: "USD".into(),
            expense_type: "refund_settlement",
            amount_cents: 200,
            provenance: "estimated",
            order_numbers: vec!["A-1".into()],
            expense_at: "2026-02-01".into(),
            basis: "original_net_refund_adjustment",
            corrects_entry_id: Some("9".into()),
            correction_reason: Some("wrong".into()),
        };
        assert_eq!(
            request_fingerprint(&expense, Some(&"f".repeat(64))),
            "c90fed44fd9c21d5738b9adaae36ba798435c90e3695dd1d62a924217ce4cb0f"
        );
    }

    #[test]
    fn order_numbers_are_trimmed_and_sorted_as_javascript_sorts_them() {
        let numbers = [" b ", "a", "", "b", "\u{1F600}", "\u{FF5E}"].map(String::from);
        assert_eq!(order_numbers(&numbers), ["a", "b", "\u{1F600}", "\u{FF5E}"]);
    }
}
