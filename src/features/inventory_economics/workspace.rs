//! The seller's economics as the Node app computes them (`/api/inventory-economics`): the parts
//! this screen shows.
use serde::Deserialize;

use crate::legacy::Legacy;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub seller_key: String,
    pub purchase_costs: Vec<PurchaseCost>,
    pub orders: Vec<Order>,
}

/// A purchase's cost, as recorded or corrected. Only the current version of each is shown.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseCost {
    pub id: String,
    pub purchase_reference: String,
    pub currency: String,
    pub total_amount_cents: i64,
    pub provenance: String,
    pub source: String,
    pub allocation_rule: String,
    pub batch_numbers: Vec<i64>,
    #[serde(default)]
    pub purchased_at: Option<String>,
    pub is_current: bool,
}

impl PurchaseCost {
    /// Where the cost came from and how it was spread: `intake; estimated; explicit; batches
    /// 2730; 2026-09-26`, as the React list wrote it.
    pub fn details(&self) -> String {
        let batches = self
            .batch_numbers
            .iter()
            .map(i64::to_string)
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

/// One order: its money in cents (none where it is not known yet) and how much of it is known.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub order_number: String,
    pub currency: String,
    #[serde(default)]
    pub gross_order_cents: Option<i64>,
    #[serde(default)]
    pub provider_net_cents: Option<i64>,
    #[serde(default)]
    pub postage_cents: Option<i64>,
    #[serde(default)]
    pub acquisition_cost_cents: Option<i64>,
    #[serde(default)]
    pub reusable_cash_cents: Option<i64>,
    #[serde(default)]
    pub realized_profit_cents: Option<i64>,
    pub proceeds_coverage: String,
    pub expense_coverage: String,
    pub cost_coverage: String,
    #[serde(default)]
    pub missing: Vec<String>,
    pub ordered_quantity: u32,
    pub settled_quantity: u32,
    pub cost_known_quantity: u32,
}

impl Order {
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
/// the Node app down).
pub async fn read(legacy: &Legacy) -> Result<Workspace, String> {
    #[derive(Deserialize)]
    struct Answer {
        workspace: Workspace,
    }
    let answer: Answer = legacy.read("/api/inventory-economics").await?;
    Ok(answer.workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(missing: &[&str]) -> Order {
        Order {
            order_number: "8520A14F-22CD78-15571".into(),
            currency: "USD".into(),
            gross_order_cents: Some(1033),
            provider_net_cents: Some(864),
            postage_cents: Some(78),
            acquisition_cost_cents: None,
            reusable_cash_cents: None,
            realized_profit_cents: None,
            proceeds_coverage: "actual".into(),
            expense_coverage: "estimated".into(),
            cost_coverage: "unknown".into(),
            missing: missing.iter().map(|m| m.to_string()).collect(),
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
        let cost: PurchaseCost = serde_json::from_str(
            r#"{"id":"18","purchaseReference":"estimated:batch-2730","currency":"USD","totalAmountCents":18265,"provenance":"estimated","source":"file_import","allocationRule":"frozen_market","batchNumbers":[2730,2731],"purchasedAt":null,"isCurrent":true}"#,
        )
        .unwrap();
        assert_eq!(
            cost.details(),
            "file import; estimated; frozen market; batches 2730, 2731; purchase date unknown"
        );
    }

    #[test]
    fn an_order_reads_with_its_unknown_amounts_left_out() {
        let order: Order = serde_json::from_str(
            r#"{"orderNumber":"A","currency":"USD","grossItemCents":0,"otherExpenseCents":0,"proceedsCoverage":"unknown","expenseCoverage":"unknown","costCoverage":"unknown","missing":["proceeds"],"orderedQuantity":1,"settledQuantity":0,"costKnownQuantity":0}"#,
        )
        .unwrap();
        assert_eq!(order.gross_order_cents, None);
        assert_eq!(order.realized_profit_cents, None);
    }
}
