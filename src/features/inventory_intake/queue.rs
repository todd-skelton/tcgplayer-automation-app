//! Handing what was counted off as a pricing batch, and the batches handed off. The Node app's
//! `/api/inventory-intake-runs` does both: it queues a batch once per request id, refuses it when
//! the counts or the seller moved since the screen showed them, records its cost and starts its
//! pricing, and lists the latest 25. Those rules stay there until the intake workers move here.
use std::collections::HashMap;

use corten::{UrlValue, prelude::*};
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

/// What queuing does with the batch: price it, or price it and publish what is ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Workflow {
    PriceOnly,
    Publish,
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
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !(fraction.is_empty() || (digits(fraction) && fraction.len() <= 2)) {
        return None;
    }
    let whole: i64 = whole.parse().ok()?;
    let fraction: i64 = format!("{fraction:0<2}").parse().ok()?;
    whole.checked_mul(100)?.checked_add(fraction)
}

/// The percent of market as typed (0 to 100, at most two decimals), or why not, in the Node
/// app's words.
pub fn read_market_percent(text: &str) -> Result<f64, &'static str> {
    match cents(text.trim()) {
        Some(hundredths) if hundredths <= 10_000 => Ok(hundredths as f64 / 10_000.0),
        _ => Err("Percent of market must be between 0 and 100 with at most two decimal places."),
    }
}

/// The amount less per card as typed (at most $100.00), in cents, or why not.
pub fn read_per_card_deduction(text: &str) -> Result<i64, &'static str> {
    match cents(text.trim()) {
        None => Err(
            "Amount less per card must be a nonnegative amount with at most two decimal places.",
        ),
        Some(c) if c > MAXIMUM_DEDUCTION_CENTS => {
            Err("Amount less per card must be at most $100.00.")
        }
        Some(c) => Ok(c),
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
                if let Err(message) = deduction {
                    errors.add(f.per_card_deduction, message);
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
                if cents(total).is_none() {
                    errors.add(
                        f.purchase_total,
                        "Purchase total must be a nonnegative amount with at most two decimal places.",
                    );
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
    pub sku: i32,
    pub quantity: i32,
}

/// The counts in SKU order, as the Node app compares them.
pub fn snapshot(quantities: &HashMap<i32, i32>) -> Vec<IntakeQuantity> {
    let mut items: Vec<IntakeQuantity> = quantities
        .iter()
        .map(|(&sku, &quantity)| IntakeQuantity { sku, quantity })
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseCost<'a> {
    purchase_reference: &'a str,
    total_amount: &'a str,
    provenance: &'static str,
    allocation_rule: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    purchased_at: Option<&'a str>,
    currency: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EstimatedCostRate {
    market_percent: String,
    per_card_deduction: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueRequest<'a> {
    request_id: &'a str,
    workflow: Workflow,
    #[serde(skip_serializing_if = "Option::is_none")]
    purchase_cost: Option<PurchaseCost<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    estimated_cost_rate: Option<EstimatedCostRate>,
    expected_inventory: &'a [IntakeQuantity],
    expected_seller_key: &'a str,
}

/// A batch the Node app queued.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    pub batch_number: i32,
}

/// What a queue request carries besides its id: what queuing does, the cost, and the counts and
/// seller the screen showed.
pub struct Queue<'a> {
    pub workflow: Workflow,
    pub cost: &'a Cost,
    pub expected: &'a [IntakeQuantity],
    pub seller_key: &'a str,
}

fn request<'a>(request_id: &'a str, queue: &'a Queue<'a>) -> QueueRequest<'a> {
    let (purchase_cost, estimated_cost_rate) = match queue.cost {
        Cost::Estimate => (None, None),
        Cost::Rate(rate) => (
            None,
            Some(EstimatedCostRate {
                market_percent: rate.market_percent(),
                per_card_deduction: rate.per_card_deduction(),
            }),
        ),
        Cost::Purchase {
            reference,
            total,
            date,
            estimated,
        } => (
            Some(PurchaseCost {
                purchase_reference: reference,
                total_amount: total,
                provenance: if *estimated { "estimated" } else { "actual" },
                allocation_rule: "quantity",
                purchased_at: date.as_deref(),
                currency: "USD",
            }),
            None,
        ),
    };
    QueueRequest {
        request_id,
        workflow: queue.workflow,
        purchase_cost,
        estimated_cost_rate,
        expected_inventory: queue.expected,
        expected_seller_key: queue.seller_key,
    }
}

/// Queues the counts as a batch, once per `request_id`: the same id again gives the same batch.
pub async fn queue(legacy: &Legacy, request_id: &str, queue: &Queue<'_>) -> Result<Queued, String> {
    legacy
        .send("/api/inventory-intake-runs", &request(request_id, queue))
        .await
}

/// The seller queued batches are counted and published for.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub seller_key: String,
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
#[derive(Clone, Debug, Deserialize)]
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

pub async fn batches(legacy: &Legacy) -> Result<Batches, String> {
    legacy.read("/api/inventory-intake-runs").await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RateChange {
    action: &'static str,
    batch_number: i32,
    market_percent: String,
    per_card_deduction: String,
}

/// Estimates a queued batch's cost again at `rate`; its earlier estimate stays in its history.
pub async fn change_rate(legacy: &Legacy, batch_number: i32, rate: CostRate) -> Result<(), String> {
    let change = RateChange {
        action: "change_estimated_cost_rate",
        batch_number,
        market_percent: rate.market_percent(),
        per_card_deduction: rate.per_card_deduction(),
    };
    let _: serde_json::Value = legacy.send("/api/inventory-economics", &change).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Err("Amount less per card must be at most $100.00.")
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
    fn the_request_is_the_json_the_node_route_reads() {
        let expected = [IntakeQuantity {
            sku: 2,
            quantity: 3,
        }];
        let cost = Cost::Rate(CostRate {
            market_rate: 0.6,
            per_unit_deduction_cents: 50,
        });
        let q = Queue {
            workflow: Workflow::PriceOnly,
            cost: &cost,
            expected: &expected,
            seller_key: "abc",
        };
        let json = serde_json::to_value(request("r1", &q)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "requestId": "r1",
                "workflow": "price_only",
                "estimatedCostRate": { "marketPercent": "60", "perCardDeduction": "0.50" },
                "expectedInventory": [{ "sku": 2, "quantity": 3 }],
                "expectedSellerKey": "abc"
            })
        );
        let cost = Cost::Purchase {
            reference: "Lot".into(),
            total: "12".into(),
            date: Some("2026-10-01".into()),
            estimated: true,
        };
        let q = Queue {
            workflow: Workflow::Publish,
            cost: &cost,
            expected: &expected,
            seller_key: "abc",
        };
        let json = serde_json::to_value(request("r2", &q)).unwrap();
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
