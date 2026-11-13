//! Recording a purchase cost, ported from `inventoryEconomicsRepository.recordPurchaseCost`, by
//! each of its rules: explicit, where each receipt lot of the batches is given its amount (the rule
//! estimates use); quantity, an entered total split across the lots by their units; and frozen
//! market, split by each lot's market value at intake times its units.
//!
//! A request is recorded once. Its fingerprint is the one Node computes, so a request either app
//! repeats is answered with the entry already saved, and one reused for other evidence is refused.
//! Entries are immutable: a change is a correction that names the series' current entry.
use serde_json::json;
use sqlx::PgConnection;

pub use super::series::{NotRecorded, Saved};
use super::{
    estimate::{ExplicitAllocation, PurchaseCost},
    ledger::{
        fingerprint::{js_float, sha256_hex, stable_json},
        money::allocate_weighted,
    },
    series::{self, Ledger, failed},
};

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
        "marketObservedAt": cost.market_observed_at,
        "correctsEntryId": cost.corrects_entry_id,
        "correctionReason": cost.correction_reason,
        "explicitAllocations": allocations(cost),
    })))
}

/// Records `cost` on `conn`, which the caller holds in a transaction.
pub async fn record(conn: &mut PgConnection, cost: &PurchaseCost) -> Result<Saved, NotRecorded> {
    if !matches!(
        cost.allocation_rule,
        "explicit" | "quantity" | "frozen_market"
    ) {
        return Err("Purchase allocation rule is invalid.".into());
    }
    if cost.allocation_rule == "frozen_market" && cost.market_observed_at.is_none() {
        return Err("Frozen market allocation requires a market evidence instant.".into());
    }
    if cost.corrects_entry_id.is_some() != cost.correction_reason.is_some() {
        return Err("A correction requires both the current entry and a reason.".into());
    }
    let explicit = cost.allocation_rule == "explicit";
    let batch_numbers = batch_numbers(cost);
    if batch_numbers.is_empty()
        || batch_numbers.len() > 100
        || batch_numbers.iter().any(|&n| n <= 0)
    {
        return Err("Purchase costs require 1 to 100 positive batch numbers.".into());
    }
    let allocations = allocations(cost);
    if explicit
        && (allocations.is_empty()
            || allocations.iter().any(|a| a.receipt_id <= 0)
            || allocations
                .windows(2)
                .any(|pair| pair[0].receipt_id == pair[1].receipt_id))
    {
        return Err("Explicit allocations require each receipt exactly once.".into());
    }
    if !explicit && !allocations.is_empty() {
        return Err("Explicit receipt amounts require the explicit allocation rule.".into());
    }
    let fingerprint = request_fingerprint(cost);
    let ledger = Ledger::PurchaseCosts;
    if let Some(saved) = series::repeated(conn, ledger, &cost.request_id, &fingerprint).await? {
        return Ok(saved);
    }
    let series = series::lock_series(
        conn,
        ledger,
        &cost.seller_key,
        &cost.purchase_reference,
        &cost.currency,
    )
    .await?;
    let correction = series::next_correction(
        conn,
        ledger,
        &series,
        cost.corrects_entry_id.as_deref(),
        cost.correction_reason.as_deref(),
    )
    .await?;

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

    let receipts: Vec<Lot> = sqlx::query_as(
        "SELECT receipt.receipt_id,receipt.seller_key,receipt.original_quantity,
           receipt.market_value::float8 AS market_value
         FROM inventory_receipt_batch_links link
         JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
         WHERE link.batch_number=ANY($1::int[])
         GROUP BY receipt.receipt_id,receipt.original_quantity,receipt.market_value,receipt.seller_key
         ORDER BY receipt.receipt_id",
    )
    .bind(&batch_numbers)
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    if receipts.is_empty() {
        return Err("No receipt lots were found for the selected batches.".into());
    }
    if receipts.iter().any(|lot| {
        lot.seller_key
            .as_deref()
            .is_some_and(|s| s != cost.seller_key)
    }) {
        return Err("Purchase receipts cannot cross sellers.".into());
    }
    let receipt_ids: Vec<i32> = receipts.iter().map(|lot| lot.receipt_id).collect();
    let (amounts, weights) = if explicit {
        explicit_amounts(&receipt_ids, &allocations, cost.total_amount_cents)?
    } else {
        by_weight(&receipts, cost.allocation_rule, cost.total_amount_cents)?
    };

    let entry_id: String = sqlx::query_scalar(
        "INSERT INTO inventory_purchase_cost_entries
          (series_id,request_id,request_fingerprint,sequence,total_amount_cents,provenance,source,allocation_rule,
           batch_numbers,purchased_at,market_observed_at,corrects_entry_id,correction_reason,evidence)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::timestamptz,$12::bigint,$13,$14::jsonb)
         RETURNING id::text",
    )
    .bind(&series)
    .bind(&cost.request_id)
    .bind(&fingerprint)
    .bind(correction.sequence)
    .bind(cost.total_amount_cents)
    .bind(cost.provenance)
    .bind(cost.source)
    .bind(cost.allocation_rule)
    .bind(&batch_numbers)
    .bind(&cost.purchased_at)
    .bind(&cost.market_observed_at)
    .bind(&correction.corrects_entry_id)
    .bind(&correction.reason)
    .bind(json!({ "allocationRule": cost.allocation_rule, "batchNumbers": batch_numbers }).to_string())
    .fetch_one(&mut *conn)
    .await
    .map_err(failed)?;
    sqlx::query(
        "INSERT INTO inventory_purchase_cost_allocations (entry_id,receipt_id,allocated_amount_cents,allocation_weight)
         SELECT $1::bigint,receipt_id,amount,weight::numeric
         FROM unnest($2::int[],$3::bigint[],$4::text[]) AS lot(receipt_id,amount,weight)",
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

/// A receipt lot of the purchase's batches.
#[derive(sqlx::FromRow)]
struct Lot {
    receipt_id: i32,
    seller_key: Option<String>,
    original_quantity: i32,
    /// Its unit market value at intake, as node-pg reads `numeric::float8`.
    market_value: Option<f64>,
}

/// Each lot's amount and weight under the explicit rule: the amount it was given, which is also
/// its weight. Both lists are sorted by receipt, so every receipt is named once exactly when the
/// ids line up.
fn explicit_amounts(
    receipt_ids: &[i32],
    allocations: &[ExplicitAllocation],
    total_amount_cents: i64,
) -> Result<(Vec<i64>, Vec<String>), String> {
    if receipt_ids.len() != allocations.len()
        || receipt_ids
            .iter()
            .zip(allocations)
            .any(|(id, a)| i64::from(*id) != a.receipt_id)
    {
        return Err("Explicit allocations must name every selected receipt exactly once.".into());
    }
    if allocations.iter().map(|a| a.amount_cents).sum::<i64>() != total_amount_cents {
        return Err("Explicit receipt allocations must equal the purchase total.".into());
    }
    let amounts: Vec<i64> = allocations.iter().map(|a| a.amount_cents).collect();
    let weights = amounts.iter().map(i64::to_string).collect();
    Ok((amounts, weights))
}

/// Each lot's amount and weight under the quantity rule (its units) or the frozen market rule
/// (its unit market value times its units, as JavaScript multiplies them): the total split by
/// weight to the cent, the cents left over going to the largest remainders and then by receipt
/// id as text (`allocateAmountCents`). The weight is kept as JavaScript prints it, which is what
/// Node saved.
fn by_weight(
    receipts: &[Lot],
    rule: &str,
    total_amount_cents: i64,
) -> Result<(Vec<i64>, Vec<String>), String> {
    let ids: Vec<String> = receipts
        .iter()
        .map(|lot| lot.receipt_id.to_string())
        .collect();
    let weights: Vec<f64> = receipts
        .iter()
        .map(|lot| {
            let units = f64::from(lot.original_quantity);
            match (rule, lot.market_value) {
                ("quantity", _) => units,
                (_, Some(market)) => market * units,
                (_, None) => f64::NAN,
            }
        })
        .collect();
    if weights.iter().any(|w| !w.is_finite()) {
        return Err("Frozen market allocation requires market evidence for every receipt.".into());
    }
    let targets: Vec<(&str, f64)> = ids
        .iter()
        .map(String::as_str)
        .zip(weights.iter().copied())
        .collect();
    let shares = allocate_weighted(total_amount_cents, &targets)?;
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
    Ok((amounts, weights.into_iter().map(js_float).collect()))
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
            market_observed_at: None,
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
