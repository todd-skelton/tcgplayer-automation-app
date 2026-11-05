//! Every order's reusable proceeds, for pooling into reinvestment: the whole history, not the
//! screen's most recent hundred, and refused when any part of the evidence was cut off at its
//! fence. Each sale carries an identity of the evidence behind it, so a plan built from it knows
//! when that evidence changed. The Node app's `loadCompleteReusableProceeds`.
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    evidence::{self, Evidence, FENCE, PostageRow},
    fingerprint::{financial, sha256_hex, stable_json},
    order::{Coverage, OrderEconomics},
    orders::calculate_orders,
};
use crate::database::Database;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sale {
    pub order_number: String,
    pub sold_at: String,
    pub currency: String,
    pub amount_cents: i64,
    pub provenance: &'static str,
    pub source_identity: String,
    pub source_identities: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteReusableProceeds {
    pub sales: Vec<Sale>,
    pub unknown_proceeds_order_count: usize,
    pub unknown_proceeds_sold_at: Vec<String>,
    pub source_evidence_identities: Vec<String>,
}

/// An instant as JavaScript's `toISOString` writes it: UTC, to the millisecond.
pub fn iso(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn postage_json(row: &PostageRow) -> Value {
    json!({
        "id": row.id,
        "providerIdentity": row.provider_identity,
        "orderNumbers": row.order_numbers,
        "currency": row.currency,
        "rateCents": row.rate_cents,
        "direction": row.direction,
        "linkedSellers": row.linked_sellers,
        "linkedOrderCount": row.linked_order_count,
    })
}

fn coverage(c: Coverage) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}

/// Sales and unknowns from every order in `evidence`, which must hold the seller's whole history.
pub fn from_evidence(
    seller: &str,
    evidence: &Evidence,
) -> Result<CompleteReusableProceeds, String> {
    if !evidence.orders_complete {
        return Err("Seller orders exceed the 10,000-order complete-evidence fence.".into());
    }
    if !evidence.postage_complete {
        return Err("Relevant postage exceeds the 10,000-row complete-evidence fence.".into());
    }
    if !evidence.expenses_complete {
        return Err(
            "Relevant order expenses exceed the 10,000-row complete-evidence fence.".into(),
        );
    }
    let summaries = calculate_orders(seller, evidence)?;
    let mut out = CompleteReusableProceeds::default();
    for (summary, order) in summaries.iter().zip(&evidence.orders) {
        let OrderEconomics {
            reusable_cash_cents,
            proceeds_coverage,
            expense_coverage,
            ..
        } = summary;
        let mut sources = vec![
            order.source_fingerprint.clone(),
            financial(&order.transaction(), &order.refund_records()),
        ];
        sources.extend(
            evidence
                .expenses
                .iter()
                .filter(|e| {
                    e.currency == order.currency && e.order_numbers.contains(&order.order_number)
                })
                .map(|e| e.evidence_identity.clone()),
        );
        for purchase in evidence
            .postage
            .iter()
            .filter(|p| p.order_numbers.contains(&order.order_number))
        {
            sources.push(purchase.provider_identity.clone());
            sources.push(sha256_hex(&stable_json(&postage_json(purchase))));
        }
        sources.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let source_identity = sha256_hex(&stable_json(&json!({
            "sources": sources,
            "cash": reusable_cash_cents,
            "proceeds": coverage(*proceeds_coverage),
            "expenses": coverage(*expense_coverage),
            "missing": summary.missing,
        })));
        out.source_evidence_identities.push(source_identity.clone());
        let Some(amount_cents) = *reusable_cash_cents else {
            out.unknown_proceeds_order_count += 1;
            out.unknown_proceeds_sold_at.push(iso(order.order_time));
            continue;
        };
        let estimated =
            *proceeds_coverage == Coverage::Estimated || *expense_coverage == Coverage::Estimated;
        out.sales.push(Sale {
            order_number: summary.order_number.clone(),
            sold_at: iso(order.order_time),
            currency: summary.currency.clone(),
            amount_cents,
            provenance: if estimated { "estimated" } else { "actual" },
            source_identity,
            source_identities: sources,
        });
    }
    out.source_evidence_identities.sort();
    Ok(out)
}

/// The seller's complete reusable proceeds, read from the database.
pub async fn load(db: &Database, seller: &str) -> Result<CompleteReusableProceeds, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    load_in(&mut conn, seller).await
}

/// [`load`] on one connection, inside a snapshot the caller holds.
pub async fn load_in(
    conn: &mut sqlx::PgConnection,
    seller: &str,
) -> Result<CompleteReusableProceeds, String> {
    let seller = seller.trim();
    let evidence = evidence::find_in(conn, seller, FENCE)
        .await
        .map_err(|e| e.to_string())?;
    from_evidence(seller, &evidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Matches what the Node app's `loadCompleteReusableProceeds` wrote to `NODE_PROCEEDS` for the
    /// dev seller (`npx vite-node scripts/ledger-proceeds-snapshot.ts`, then
    /// `NODE_PROCEEDS=target/node-proceeds.json cargo test complete_proceeds_match_node -- --ignored`).
    #[tokio::test]
    #[ignore = "reads the dev database and a file the Node app wrote"]
    async fn complete_proceeds_match_node() {
        crate::config::load_env();
        let path = std::env::var("NODE_PROCEEDS").expect("NODE_PROCEEDS names Node's answer");
        let node: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let db = Database::connect_lazy(&crate::config::database_url());
        let ours = serde_json::to_value(load(&db, "8520a14f").await.unwrap()).unwrap();
        assert_eq!(
            ours["unknownProceedsOrderCount"],
            node["unknownProceedsOrderCount"]
        );
        assert_eq!(
            ours["sales"].as_array().unwrap().len(),
            node["sales"].as_array().unwrap().len()
        );
        for (o, n) in ours["sales"]
            .as_array()
            .unwrap()
            .iter()
            .zip(node["sales"].as_array().unwrap())
        {
            assert_eq!(o, n, "sale {}", o["orderNumber"]);
        }
        assert_eq!(ours, node);
    }
}
