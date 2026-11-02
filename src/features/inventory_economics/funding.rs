//! Recording a funding adjustment (cash the business started with, put in, took out, set aside or
//! released, or spent on a recorded purchase), ported from
//! `inventoryEconomicsRepository.recordFundingAdjustment`. Recorded once per request, corrected
//! by later entries of its series, as every economics ledger is (`super::series`).
use serde_json::json;
use sqlx::PgConnection;

use super::{
    details::{MAX_SAFE_INTEGER, currency, ledger_date, required_text},
    ledger::fingerprint::{sha256_hex, stable_json},
    series::{self, Ledger, NotRecorded, Saved, failed},
};

/// The adjustments the ledger takes.
pub const ADJUSTMENT_TYPES: [&str; 6] = [
    "opening_cash",
    "external_contribution",
    "withdrawal",
    "reserve",
    "reserve_release",
    "purchase_funding",
];

/// What Node's `recordFundingAdjustment` is given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Funding {
    pub request_id: String,
    pub seller_key: String,
    pub adjustment_reference: String,
    pub currency: String,
    pub adjustment_type: &'static str,
    pub amount_cents: i64,
    pub provenance: &'static str,
    /// `YYYY-MM-DD`.
    pub effective_at: String,
    /// The purchase a `purchase_funding` adjustment paid for; ignored for the others.
    pub purchase_reference: Option<String>,
    pub corrects_entry_id: Option<String>,
    pub correction_reason: Option<String>,
}

/// What a checked request says, as Node fingerprints it to tell a repeat from a reuse of its id.
pub fn request_fingerprint(funding: &Funding) -> String {
    sha256_hex(&stable_json(&json!({
        "sellerKey": funding.seller_key,
        "reference": funding.adjustment_reference,
        "currency": funding.currency,
        "adjustmentType": funding.adjustment_type,
        "amountCents": funding.amount_cents,
        "provenance": funding.provenance,
        "effectiveAt": funding.effective_at,
        "purchaseReference": funding.purchase_reference,
        "correctsEntryId": funding.corrects_entry_id,
        "correctionReason": funding.correction_reason.as_deref().map(crate::api::js_trim),
    })))
}

/// Records `funding` on `conn`, which the caller holds in a transaction.
pub async fn record(conn: &mut PgConnection, funding: &Funding) -> Result<Saved, NotRecorded> {
    let request_id = required_text(&funding.request_id, "Request ID")?;
    let seller_key = required_text(&funding.seller_key, "Seller key")?;
    let reference = required_text(&funding.adjustment_reference, "Adjustment reference")?;
    let currency = currency(&funding.currency)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&funding.amount_cents) {
        return Err("Funding amount must be nonnegative whole cents.".into());
    }
    let effective_at = ledger_date(&funding.effective_at, "Effective date")?;
    let purchase_reference = if funding.adjustment_type == "purchase_funding" {
        let reference = funding.purchase_reference.as_deref().unwrap_or("");
        Some(required_text(reference, "Purchase reference")?)
    } else {
        None
    };
    if let Some(purchase) = &purchase_reference {
        let recorded: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM inventory_purchase_cost_series series
             JOIN inventory_purchase_cost_entries entry ON entry.series_id=series.id
             WHERE series.seller_key=$1 AND series.purchase_reference=$2 AND series.currency=$3 LIMIT 1",
        )
        .bind(&seller_key)
        .bind(purchase)
        .bind(&currency)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
        if recorded.is_none() {
            return Err("Purchase funding must reference a recorded purchase for the same seller and currency.".into());
        }
    }
    let funding = &Funding {
        request_id,
        seller_key,
        adjustment_reference: reference,
        currency,
        effective_at,
        purchase_reference,
        ..funding.clone()
    };
    let (request_id, seller_key, reference, currency) = (
        &funding.request_id,
        &funding.seller_key,
        &funding.adjustment_reference,
        &funding.currency,
    );
    let (effective_at, purchase_reference) = (&funding.effective_at, &funding.purchase_reference);
    let fingerprint = request_fingerprint(funding);
    let ledger = Ledger::Funding;
    if let Some(saved) = series::repeated(conn, ledger, request_id, &fingerprint).await? {
        return Ok(saved);
    }
    let series = series::lock_series(conn, ledger, seller_key, reference, currency).await?;
    let correction = series::next_correction(
        conn,
        ledger,
        &series,
        funding.corrects_entry_id.as_deref(),
        funding.correction_reason.as_deref(),
    )
    .await?;
    let entry_id: String = sqlx::query_scalar(
        "INSERT INTO inventory_funding_entries
          (series_id,request_id,request_fingerprint,sequence,adjustment_type,amount_cents,provenance,effective_at,
           purchase_reference,corrects_entry_id,correction_reason)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::bigint,$11) RETURNING id::text",
    )
    .bind(&series)
    .bind(request_id)
    .bind(&fingerprint)
    .bind(correction.sequence)
    .bind(funding.adjustment_type)
    .bind(funding.amount_cents)
    .bind(funding.provenance)
    .bind(effective_at)
    .bind(purchase_reference)
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
        let funding = Funding {
            request_id: "r".into(),
            seller_key: "seller".into(),
            adjustment_reference: "port-twice".into(),
            currency: "USD".into(),
            adjustment_type: "purchase_funding",
            amount_cents: 40_000,
            provenance: "actual",
            effective_at: "2026-01-01".into(),
            purchase_reference: Some("estimated:batch-206".into()),
            corrects_entry_id: Some("17".into()),
            correction_reason: Some("late".into()),
        };
        assert_eq!(
            request_fingerprint(&funding),
            "9f509389ec4b560054454af7e5cbe3a78fa2297d4183f34664fe7080f4b9e3c3"
        );
    }
}
