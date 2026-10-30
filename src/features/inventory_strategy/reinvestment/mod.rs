//! Reinvestment turnaround: how long sale proceeds took to come back on sale as replacement
//! inventory, pooled by currency. Proceeds, purchase costs, funding and publications are matched
//! in time order, outside cash first, and each match is a sample with its days. Ported from
//! `allocateReinvestmentTurnaround.ts`, `purchaseCapital.ts` and
//! `reinvestmentTurnaround.server.ts`; the report keeps the Node app's JSON shape, since both apps
//! read and write the saved rebuilds while both run.
use serde::{Deserialize, Serialize};

mod allocate;
mod capital;
pub mod source;

pub(crate) use allocate::instant;
pub use allocate::{allocate, unsupported_funding_for};
pub use capital::purchase_capital;

pub const RULE_VERSION: &str = "pooled-proceeds/v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provenance {
    Actual,
    Estimated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FundingProvenance {
    Actual,
    Estimated,
    Inferred,
}

impl From<Provenance> for FundingProvenance {
    fn from(p: Provenance) -> Self {
        match p {
            Provenance::Actual => FundingProvenance::Actual,
            Provenance::Estimated => FundingProvenance::Estimated,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimingBasis {
    KnownPurchase,
    KnownFunding,
    SaleToPublicationInference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AllocationState {
    Completed,
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicationState {
    Confirmed,
    Waiting,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleProceeds {
    pub order_number: String,
    pub sold_at: String,
    pub currency: String,
    pub amount_cents: i64,
    pub provenance: Provenance,
    pub source_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_identities: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tranche {
    pub receipt_id: i64,
    pub product_line_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_item_id: Option<String>,
    pub amount_cents: i64,
    pub quantity: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub publication_state: PublicationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_identity: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseFunding {
    pub adjustment_reference: String,
    pub amount_cents: i64,
    pub effective_at: String,
    pub provenance: Provenance,
    pub source_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub purchase_reference: String,
    pub currency: String,
    pub total_amount_cents: i64,
    pub cost_provenance: Provenance,
    pub cost_source_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchased_at: Option<String>,
    pub funding: Vec<PurchaseFunding>,
    pub tranches: Vec<Tranche>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedKind {
    Orphan,
    AboveCurrentCost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedFunding {
    pub kind: UnsupportedKind,
    pub adjustment_reference: String,
    pub purchase_reference: Option<String>,
    pub currency: String,
    pub amount_cents: i64,
    pub effective_at: String,
    pub source_identity: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentType {
    OpeningCash,
    ExternalContribution,
    Withdrawal,
    Reserve,
    ReserveRelease,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingAdjustment {
    pub adjustment_reference: String,
    pub currency: String,
    pub adjustment_type: AdjustmentType,
    pub amount_cents: i64,
    pub effective_at: String,
    pub provenance: Provenance,
    pub source_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownCost {
    pub receipt_id: i64,
    pub product_line_id: i64,
    pub occurred_at: Option<String>,
}

/// The latest complete order sync from TCGplayer, to say how far the orders are known.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderCoverage {
    pub run_id: String,
    pub source: String,
    pub status: String,
    pub search_range: Option<String>,
    pub finished_at: String,
    pub next_offset: i64,
    pub expected_total: Option<i64>,
    pub orders_observed: i64,
    pub details_recorded: i64,
    pub observed_from: Option<String>,
    pub observed_through: Option<String>,
    pub gaps: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub seller_key: String,
    pub as_of: String,
    pub sales: Vec<SaleProceeds>,
    pub purchases: Vec<Purchase>,
    pub unsupported_purchase_funding: Vec<UnsupportedFunding>,
    pub funding_adjustments: Vec<FundingAdjustment>,
    pub unknown_proceeds_order_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_proceeds_sold_at: Option<Vec<Option<String>>>,
    pub unknown_cost_receipt_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_cost_occurred_at: Option<Vec<Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_cost_receipts: Option<Vec<UnknownCost>>,
    /// Present (perhaps null) when built from the database; left out by the tests' inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_coverage: Option<Option<OrderCoverage>>,
    pub source_evidence_identities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub sample_key: String,
    pub currency: String,
    pub order_number: String,
    pub purchase_reference: String,
    pub receipt_id: i64,
    pub product_line_id: i64,
    pub amount_cents: i64,
    pub sold_at: String,
    pub funding_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub state: AllocationState,
    pub timing_basis: TimingBasis,
    pub proceeds_provenance: Provenance,
    pub cost_provenance: Provenance,
    pub funding_provenance: FundingProvenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funding_adjustment_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turnaround_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_age_days: Option<f64>,
    pub explanation: String,
    pub source_identities: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencySummary {
    pub currency: String,
    pub eligible_proceeds_cents: i64,
    pub negative_proceeds_cents: i64,
    pub completed_cents: i64,
    pub waiting_cents: i64,
    pub unallocated_proceeds_cents: i64,
    pub reserved_or_withdrawn_cents: i64,
    pub unsupported_funding_adjustment_cents: i64,
    pub outside_funding_used_cents: i64,
    pub outside_funding_supplied_cents: i64,
    pub outside_deficit_settlement_cents: i64,
    pub outside_available_cents: i64,
    pub outside_reserved_or_withdrawn_cents: i64,
    pub outstanding_negative_deficit_cents: i64,
    pub unresolved_purchase_cost_cents: i64,
    pub reinvested_percent: Option<f64>,
    pub completion_coverage_percent: Option<f64>,
    pub completed_dollar_weighted_mean_days: Option<f64>,
    pub completed_weighted_median_days: Option<f64>,
    pub completed_weighted_p90_days: Option<f64>,
    pub waiting_dollar_weighted_age_days: Option<f64>,
    pub oldest_waiting_days: Option<f64>,
    pub unallocated_dollar_weighted_age_days: Option<f64>,
    pub oldest_unallocated_days: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub reason: String,
    pub count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoldAt {
    pub sold_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub observed_order_count: i64,
    pub eligible_order_count: i64,
    pub unknown_proceeds_order_count: i64,
    pub purchase_count: i64,
    pub costed_receipt_count: i64,
    pub unknown_cost_receipt_count: i64,
    pub unknown_proceeds: Vec<SoldAt>,
    pub unknown_costs: Vec<UnknownCost>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub seller_key: String,
    pub as_of: String,
    pub rule_version: String,
    pub source_fingerprint: String,
    pub current_corrected_view: bool,
    pub date_precision: String,
    pub currencies: Vec<CurrencySummary>,
    pub samples: Vec<Sample>,
    pub unsupported_purchase_funding: Vec<UnsupportedFunding>,
    pub excluded: Vec<Excluded>,
    pub coverage: Coverage,
    pub order_coverage: Option<OrderCoverage>,
    pub convention: Vec<String>,
}
