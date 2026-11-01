//! Recording a purchase cost, ported from `inventoryEconomicsRepository.recordPurchaseCost` for the
//! two rules the app records: explicit, the one estimates use, where each receipt lot of the
//! batches is given its amount; and quantity, an entered total split across the lots by their
//! units.
//!
//! A request is recorded once. Its fingerprint is the one Node computes, so a request either app
//! repeats is answered with the entry already saved, and one reused for other evidence is refused.
//! Entries are immutable: a change is a correction that names the series' current entry.
use serde_json::json;
use sqlx::PgConnection;

use super::{
    estimate::{ExplicitAllocation, PurchaseCost},
    ledger::{
        fingerprint::{sha256_hex, stable_json},
        money::allocate,
    },
};

/// The entry a request saved, or found already saved for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    pub entry_id: String,
    pub repeated: bool,
}

fn batch_numbers(cost: &PurchaseCost) -> Vec<i32> {
    let mut numbers = cost.batch_numbers.clone();
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

fn allocations(cost: &PurchaseCost) -> Vec<ExplicitAllocation> {
    let mut allocations = cost.explicit_allocations.clone();
    allocations.sort_by_key(|a| a.receipt_id);
    allocations
}

/// What a request says, as Node fingerprints it to tell a repeat from a reuse of its id.
pub fn request_fingerprint(cost: &PurchaseCost) -> String {
    sha256_hex(&stable_json(&json!({
        "sellerKey": cost.seller_key,
        "purchaseReference": cost.purchase_reference,
        "currency": cost.currency,
        "totalAmountCents": cost.total_amount_cents,
        "provenance": cost.provenance,
        "source": cost.source,
        "allocationRule": cost.allocation_rule,
        "batchNumbers": batch_numbers(cost),
        "purchasedAt": cost.purchased_at,
        "marketObservedAt": null,
        "correctsEntryId": cost.corrects_entry_id,
        "correctionReason": cost.correction_reason,
        "explicitAllocations": allocations(cost),
    })))
}

/// Why a purchase cost was not recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotRecorded {
    /// It conflicts with what is recorded: a request id reused for other evidence, a correction
    /// of an entry that is not the current one, or a lot another purchase owns. Node's
    /// `InventoryEconomicsConflictError`.
    Conflict(String),
    /// Anything else: input it does not take, lots it cannot find, the database failing.
    Failed(String),
}

impl From<&str> for NotRecorded {
    fn from(message: &str) -> Self {
        NotRecorded::Failed(message.to_owned())
    }
}

impl From<String> for NotRecorded {
    fn from(message: String) -> Self {
        NotRecorded::Failed(message)
    }
}

impl From<NotRecorded> for String {
    fn from(not: NotRecorded) -> Self {
        match not {
            NotRecorded::Conflict(message) | NotRecorded::Failed(message) => message,
        }
    }
}

/// Records `cost` on `conn`, which the caller holds in a transaction.
pub async fn record(conn: &mut PgConnection, cost: &PurchaseCost) -> Result<Saved, NotRecorded> {
    let failed = |e: sqlx::Error| NotRecorded::Failed(e.to_string());
    let explicit = match cost.allocation_rule {
        "explicit" => true,
        "quantity" => false,
        _ => return Err("Only explicit and quantity purchase costs are recorded here.".into()),
    };
    let batch_numbers = batch_numbers(cost);
    if batch_numbers.is_empty()
        || batch_numbers.len() > 100
        || batch_numbers.iter().any(|&n| n <= 0)
    {
        return Err("Purchase costs require 1 to 100 positive batch numbers.".into());
    }
    let allocations = allocations(cost);
    if !explicit && !allocations.is_empty() {
        return Err("Explicit receipt amounts require the explicit allocation rule.".into());
    }
    if explicit
        && (allocations.is_empty()
            || allocations.iter().any(|a| a.receipt_id <= 0)
            || allocations
                .windows(2)
                .any(|pair| pair[0].receipt_id == pair[1].receipt_id))
    {
        return Err("Explicit allocations require each receipt exactly once.".into());
    }
    if cost.corrects_entry_id.is_some() != cost.correction_reason.is_some() {
        return Err("A correction requires both the current entry and a reason.".into());
    }
    let fingerprint = request_fingerprint(cost);

    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("inventory-economics:{}", cost.request_id))
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    let repeated: Option<(String, String)> = sqlx::query_as(
        "SELECT id::text, request_fingerprint FROM inventory_purchase_cost_entries WHERE request_id=$1",
    )
    .bind(&cost.request_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    if let Some((entry_id, saved)) = repeated {
        if saved != fingerprint {
            return Err(NotRecorded::Conflict(
                "Request ID was already used for different inventory economics evidence.".into(),
            ));
        }
        return Ok(Saved {
            entry_id,
            repeated: true,
        });
    }

    sqlx::query(
        "INSERT INTO inventory_purchase_cost_series (seller_key,purchase_reference,currency)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(&cost.seller_key)
    .bind(&cost.purchase_reference)
    .bind(&cost.currency)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    let series: String = sqlx::query_scalar(
        "SELECT id::text FROM inventory_purchase_cost_series
         WHERE seller_key=$1 AND purchase_reference=$2 AND currency=$3 FOR UPDATE",
    )
    .bind(&cost.seller_key)
    .bind(&cost.purchase_reference)
    .bind(&cost.currency)
    .fetch_one(&mut *conn)
    .await
    .map_err(failed)?;

    let current: Option<(String, i32)> = sqlx::query_as(
        "SELECT id::text,sequence FROM inventory_purchase_cost_entries
         WHERE series_id=$1::bigint ORDER BY sequence DESC LIMIT 1",
    )
    .bind(&series)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    let sequence = match (current, &cost.corrects_entry_id) {
        (None, None) => 1,
        (None, Some(_)) => {
            return Err(NotRecorded::Conflict(
                "An initial entry cannot be a correction.".into(),
            ));
        }
        (Some((id, sequence)), Some(corrects)) if *corrects == id => sequence + 1,
        (Some((id, _)), _) => {
            return Err(NotRecorded::Conflict(format!(
                "A correction must reference the current entry {id}."
            )));
        }
    };

    let receipt_ids: Vec<i32> = sqlx::query_scalar(
        "SELECT receipt.receipt_id FROM inventory_receipts receipt
         WHERE EXISTS (SELECT 1 FROM inventory_receipt_batch_links link
           WHERE link.receipt_id=receipt.receipt_id AND link.batch_number=ANY($1::int[]))
         ORDER BY receipt.receipt_id LIMIT 10001 FOR UPDATE",
    )
    .bind(&batch_numbers)
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    if receipt_ids.is_empty() {
        return Err("No receipt lots were found for the selected batches.".into());
    }
    if receipt_ids.len() > 10_000 {
        return Err("A purchase cost is limited to 10,000 receipt lots.".into());
    }
    sqlx::query(
        "UPDATE inventory_receipts SET seller_key=$1 WHERE receipt_id=ANY($2::int[]) AND seller_key IS NULL",
    )
    .bind(&cost.seller_key)
    .bind(&receipt_ids)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    sqlx::query(
        "INSERT INTO inventory_purchase_receipt_ownership (receipt_id,series_id,currency)
         SELECT receipt_id,$2::bigint,$3 FROM unnest($1::int[]) AS receipt_id ON CONFLICT DO NOTHING",
    )
    .bind(&receipt_ids)
    .bind(&series)
    .bind(&cost.currency)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    let owned_elsewhere: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM inventory_purchase_receipt_ownership
         WHERE receipt_id=ANY($1::int[]) AND (series_id<>$2::bigint OR currency<>$3) LIMIT 1",
    )
    .bind(&receipt_ids)
    .bind(&series)
    .bind(&cost.currency)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    if owned_elsewhere.is_some() {
        return Err(NotRecorded::Conflict(
            "A receipt lot already belongs to another purchase or currency.".into(),
        ));
    }

    let receipts: Vec<(i32, Option<String>, i32)> = sqlx::query_as(
        "SELECT receipt.receipt_id,receipt.seller_key,receipt.original_quantity
         FROM inventory_receipt_batch_links link
         JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
         WHERE link.batch_number=ANY($1::int[])
         GROUP BY receipt.receipt_id,receipt.seller_key,receipt.original_quantity
         ORDER BY receipt.receipt_id",
    )
    .bind(&batch_numbers)
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    if receipts.is_empty() {
        return Err("No receipt lots were found for the selected batches.".into());
    }
    if receipts
        .iter()
        .any(|(_, seller, _)| seller.as_deref().is_some_and(|s| s != cost.seller_key))
    {
        return Err("Purchase receipts cannot cross sellers.".into());
    }
    let receipt_ids: Vec<i32> = receipts.iter().map(|(id, _, _)| *id).collect();
    let (amounts, weights) = if explicit {
        explicit_amounts(&receipt_ids, &allocations, cost.total_amount_cents)?
    } else {
        by_quantity(&receipts, cost.total_amount_cents)?
    };

    let entry_id: String = sqlx::query_scalar(
        "INSERT INTO inventory_purchase_cost_entries
          (series_id,request_id,request_fingerprint,sequence,total_amount_cents,provenance,source,allocation_rule,
           batch_numbers,purchased_at,market_observed_at,corrects_entry_id,correction_reason,evidence)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,NULL,$11::bigint,$12,$13::jsonb)
         RETURNING id::text",
    )
    .bind(&series)
    .bind(&cost.request_id)
    .bind(&fingerprint)
    .bind(sequence)
    .bind(cost.total_amount_cents)
    .bind(cost.provenance)
    .bind(cost.source)
    .bind(cost.allocation_rule)
    .bind(&batch_numbers)
    .bind(&cost.purchased_at)
    .bind(&cost.corrects_entry_id)
    .bind(&cost.correction_reason)
    .bind(json!({ "allocationRule": cost.allocation_rule, "batchNumbers": batch_numbers }).to_string())
    .fetch_one(&mut *conn)
    .await
    .map_err(failed)?;
    sqlx::query(
        "INSERT INTO inventory_purchase_cost_allocations (entry_id,receipt_id,allocated_amount_cents,allocation_weight)
         SELECT $1::bigint,receipt_id,amount,weight
         FROM unnest($2::int[],$3::bigint[],$4::bigint[]) AS lot(receipt_id,amount,weight)",
    )
    .bind(&entry_id)
    .bind(&receipt_ids)
    .bind(&amounts)
    .bind(&weights)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    Ok(Saved {
        entry_id,
        repeated: false,
    })
}

/// Each lot's amount and weight under the explicit rule: the amount it was given, which is also
/// its weight. Both lists are sorted by receipt, so every receipt is named once exactly when the
/// ids line up.
fn explicit_amounts(
    receipt_ids: &[i32],
    allocations: &[ExplicitAllocation],
    total_amount_cents: i64,
) -> Result<(Vec<i64>, Vec<i64>), String> {
    if receipt_ids.len() != allocations.len()
        || receipt_ids
            .iter()
            .zip(allocations)
            .any(|(id, a)| *id != a.receipt_id)
    {
        return Err("Explicit allocations must name every selected receipt exactly once.".into());
    }
    if allocations.iter().map(|a| a.amount_cents).sum::<i64>() != total_amount_cents {
        return Err("Explicit receipt allocations must equal the purchase total.".into());
    }
    let amounts: Vec<i64> = allocations.iter().map(|a| a.amount_cents).collect();
    Ok((amounts.clone(), amounts))
}

/// Each lot's amount and weight under the quantity rule: the total split by the lots' units, to
/// the cent, the cents left over going to the largest remainders and then by receipt id as text
/// (`allocateAmountCents`).
fn by_quantity(
    receipts: &[(i32, Option<String>, i32)],
    total_amount_cents: i64,
) -> Result<(Vec<i64>, Vec<i64>), String> {
    let ids: Vec<String> = receipts.iter().map(|(id, _, _)| id.to_string()).collect();
    let mut targets = Vec::with_capacity(receipts.len());
    for ((_, _, quantity), id) in receipts.iter().zip(&ids) {
        let weight = u64::try_from(*quantity)
            .map_err(|_| format!("Allocation weight for {id} must be nonnegative."))?;
        targets.push((id.as_str(), weight));
    }
    let shares = allocate(total_amount_cents, &targets)
        .ok_or("Allocation weights must include a positive value.")?;
    let amounts = ids
        .iter()
        .map(|id| {
            shares
                .iter()
                .find(|share| share.id == *id)
                .map(|share| share.cents)
                .expect("every lot has a share")
        })
        .collect();
    let weights = receipts.iter().map(|(_, _, q)| i64::from(*q)).collect();
    Ok((amounts, weights))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cost() -> PurchaseCost {
        PurchaseCost {
            request_id: "estimated-purchase-cost:market-rate-v2:batch-7".into(),
            seller_key: "seller".into(),
            purchase_reference: "estimated:batch-7".into(),
            currency: "USD".into(),
            total_amount_cents: 690,
            provenance: "estimated",
            source: "intake",
            allocation_rule: "explicit",
            batch_numbers: vec![7],
            purchased_at: Some("2026-01-02".into()),
            explicit_allocations: vec![
                ExplicitAllocation {
                    receipt_id: 12,
                    amount_cents: 720,
                },
                ExplicitAllocation {
                    receipt_id: 3,
                    amount_cents: -30,
                },
            ],
            corrects_entry_id: None,
            correction_reason: None,
        }
    }

    /// Node: `fingerprint({sellerKey:"seller",purchaseReference:"estimated:batch-7",currency:"USD",
    /// totalAmountCents:690,provenance:"estimated",source:"intake",allocationRule:"explicit",
    /// batchNumbers:[7],purchasedAt:"2026-01-02",marketObservedAt:null,correctsEntryId:null,
    /// correctionReason:null,explicitAllocations:[{receiptId:3,amountCents:-30},{receiptId:12,amountCents:720}]})`.
    #[test]
    fn fingerprints_a_request_as_node_does() {
        assert_eq!(
            request_fingerprint(&cost()),
            "a4116800b2521e8ca48734c81ae660c135399e1d762677895cf32411c17cae5c"
        );
    }
}
