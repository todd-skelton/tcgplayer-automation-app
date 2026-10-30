//! The seller's economics, computed here from the ledger (`ledger`): the parts this screen shows.
use super::ledger::{
    evidence::{self, PurchaseCostRow},
    order::OrderEconomics,
    orders::calculate_orders,
};
use crate::{database::Database, features::shipping_configuration};

/// The screen's most recent orders and purchases, as the Node app's workspace limits them.
const RECENT: i64 = 100;

pub type PurchaseCost = PurchaseCostRow;
pub type Order = OrderEconomics;

pub struct Workspace {
    pub seller_key: String,
    /// The current version of each recently recorded purchase cost.
    pub purchase_costs: Vec<PurchaseCost>,
    pub orders: Vec<Order>,
}

impl PurchaseCostRow {
    /// Where the cost came from and how it was spread: `intake; estimated; explicit; batches
    /// 2730; 2026-09-26`, as the React list wrote it.
    pub fn details(&self) -> String {
        let batches = self
            .batch_numbers
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        [
            self.source.replace('_', " "),
            self.provenance.clone(),
            self.allocation_rule.replace('_', " "),
            format!("batches {batches}"),
            self.purchased_at
                .clone()
                .unwrap_or_else(|| "purchase date unknown".into()),
        ]
        .join("; ")
    }
}

impl OrderEconomics {
    /// How much of the order is known, as the React table's Coverage column wrote it.
    pub fn coverage(&self) -> String {
        let missing = if self.missing.is_empty() {
            String::new()
        } else {
            format!(" Missing: {}.", self.missing.join(", "))
        };
        format!(
            "{} proceeds; {} expenses; {} cost. Quantities: {} ordered, {} settled, {} cost known.{missing}",
            self.proceeds_coverage,
            self.expense_coverage,
            self.cost_coverage,
            self.ordered_quantity,
            self.settled_quantity,
            self.cost_known_quantity,
        )
    }
}

/// The default shipping seller's workspace, or why it could not be read (no seller configured,
/// the database unreachable).
pub async fn read(db: &Database) -> Result<Workspace, String> {
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| e.to_string())?;
    let seller = seller.trim();
    if seller.is_empty() {
        return Err(
            "Configure a default shipping seller before recording inventory economics.".into(),
        );
    }
    let (costs, evidence) = tokio::join!(
        evidence::current_purchase_costs(db, seller, RECENT),
        evidence::find(db, seller, RECENT),
    );
    let evidence = evidence.map_err(|e| e.to_string())?;
    Ok(Workspace {
        seller_key: seller.to_owned(),
        purchase_costs: costs.map_err(|e| e.to_string())?,
        orders: calculate_orders(seller, &evidence)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::inventory_economics::ledger::order::Coverage;

    fn order(missing: &[&'static str]) -> Order {
        Order {
            order_number: "8520A14F-22CD78-15571".into(),
            currency: "USD".into(),
            gross_order_cents: Some(1033),
            provider_net_cents: Some(864),
            postage_cents: Some(78),
            other_expense_cents: 0,
            acquisition_cost_cents: None,
            reusable_cash_cents: None,
            realized_profit_cents: None,
            proceeds_coverage: Coverage::Actual,
            expense_coverage: Coverage::Estimated,
            cost_coverage: Coverage::Unknown,
            missing: missing.to_vec(),
            ordered_quantity: 2,
            settled_quantity: 2,
            cost_known_quantity: 0,
        }
    }

    #[test]
    fn coverage_names_what_is_known_and_what_is_missing() {
        assert_eq!(
            order(&[]).coverage(),
            "actual proceeds; estimated expenses; unknown cost. Quantities: 2 ordered, 2 settled, 0 cost known."
        );
        assert_eq!(
            order(&["acquisition cost", "postage"]).coverage(),
            "actual proceeds; estimated expenses; unknown cost. Quantities: 2 ordered, 2 settled, 0 cost known. Missing: acquisition cost, postage."
        );
    }

    #[test]
    fn a_purchase_cost_says_where_it_came_from() {
        let cost = PurchaseCost {
            id: "18".into(),
            purchase_reference: "estimated:batch-2730".into(),
            currency: "USD".into(),
            total_amount_cents: 18265,
            provenance: "estimated".into(),
            source: "file_import".into(),
            allocation_rule: "frozen_market".into(),
            batch_numbers: vec![2730, 2731],
            purchased_at: None,
        };
        assert_eq!(
            cost.details(),
            "file import; estimated; frozen market; batches 2730, 2731; purchase date unknown"
        );
    }

    /// Every order on the dev seller's screen matches what the Node app computes, to the cent.
    /// Needs the dev database and the Node app: `cargo test ledger_matches_node -- --ignored`.
    #[tokio::test]
    #[ignore = "reads the dev database and the running Node app"]
    async fn ledger_matches_node() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let ours = read(&db).await.expect("the Rust workspace");
        let url = format!("{}/api/inventory-economics", crate::config::legacy_origin());
        let body = reqwest::get(url).await.unwrap().text().await.unwrap();
        let node: serde_json::Value = serde_json::from_str(&body).expect("Node's workspace JSON");
        let theirs = node["workspace"]["orders"]
            .as_array()
            .expect("Node orders")
            .clone();
        assert_eq!(ours.orders.len(), theirs.len());
        for (o, t) in ours.orders.iter().zip(&theirs) {
            let ours = serde_json::json!({
                "orderNumber": o.order_number, "currency": o.currency,
                "grossOrderCents": o.gross_order_cents, "providerNetCents": o.provider_net_cents,
                "postageCents": o.postage_cents, "otherExpenseCents": o.other_expense_cents,
                "acquisitionCostCents": o.acquisition_cost_cents, "reusableCashCents": o.reusable_cash_cents,
                "realizedProfitCents": o.realized_profit_cents, "proceedsCoverage": o.proceeds_coverage,
                "expenseCoverage": o.expense_coverage, "costCoverage": o.cost_coverage, "missing": o.missing,
                "orderedQuantity": o.ordered_quantity, "settledQuantity": o.settled_quantity,
                "costKnownQuantity": o.cost_known_quantity,
            });
            let theirs: serde_json::Map<String, serde_json::Value> = ours
                .as_object()
                .unwrap()
                .keys()
                .map(|k| {
                    (
                        k.clone(),
                        t.get(k).cloned().unwrap_or(serde_json::Value::Null),
                    )
                })
                .collect();
            assert_eq!(
                ours,
                serde_json::Value::Object(theirs),
                "order {}",
                o.order_number
            );
        }
        let current: Vec<String> = node["workspace"]["purchaseCosts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["isCurrent"] == true)
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            ours.purchase_costs
                .iter()
                .map(|c| c.id.clone())
                .collect::<Vec<_>>(),
            current
        );
    }
}
