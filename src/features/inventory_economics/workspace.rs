//! The seller's economics, computed here from the ledger (`ledger`): the parts this screen shows.
use super::ledger::{
    evidence::{self, PurchaseCostRow},
    order::OrderEconomics,
    orders::calculate_orders,
};
use crate::{database::Database, features::shipping_configuration};

/// How many of the most recent orders and purchases the screen shows.
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
    /// 2730; 2026-09-26`.
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
    /// How much of the order is known, for the table's Coverage column.
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
            gross_item_cents: 933,
            gross_shipping_cents: Some(100),
            gross_order_cents: Some(1033),
            platform_fee_cents: Some(169),
            provider_net_cents: Some(864),
            refund_gross_cents: None,
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
}
