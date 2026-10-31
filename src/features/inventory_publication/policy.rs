//! Whether a priced SKU may be published (`evaluateInventoryPublicationCandidate`), under the
//! publication policy the settings hold (`normalizePolicy`).
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::features::inventory_economics::ledger::assumptions::js_round;

/// Where a batch comes from, as publications name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    PendingInventory,
    Seller,
    Csv,
    Continuous,
}

impl Source {
    pub const ALL: [Source; 4] = [
        Source::PendingInventory,
        Source::Seller,
        Source::Csv,
        Source::Continuous,
    ];

    pub fn of(text: &str) -> Option<Source> {
        Source::ALL.into_iter().find(|s| s.as_str() == text)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Source::PendingInventory => "pending_inventory",
            Source::Seller => "seller",
            Source::Csv => "csv",
            Source::Continuous => "continuous",
        }
    }
}

/// The publication policy.
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub automatic_publishing_enabled: bool,
    pub automatic_sources: Vec<Source>,
    pub allow_warnings: bool,
    pub maximum_candidate_age_ms: i64,
    pub minimum_absolute_price_change: f64,
    pub minimum_relative_price_change_percent: f64,
    pub staged_micro_batch_maximum: i64,
    pub staged_flush_window_ms: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            automatic_publishing_enabled: false,
            automatic_sources: Vec::new(),
            allow_warnings: false,
            maximum_candidate_age_ms: 60 * 60 * 1000,
            minimum_absolute_price_change: 0.01,
            minimum_relative_price_change_percent: 0.0,
            staged_micro_batch_maximum: 250,
            staged_flush_window_ms: 60 * 1000,
        }
    }
}

impl Policy {
    /// The stored policy, each missing or out-of-range value its default (`normalizePolicy`).
    pub fn of(stored: &Value) -> Policy {
        let d = Policy::default();
        let number = |value: &Value, fallback: f64, min: f64, max: f64| {
            value
                .as_f64()
                .filter(|n| n.is_finite() && (min..=max).contains(n))
                .unwrap_or(fallback)
        };
        let integer = |value: &Value, fallback: i64, min: f64, max: f64| {
            let n = number(value, fallback as f64, min, max);
            if n.fract() == 0.0 { n as i64 } else { fallback }
        };
        let flag = |value: &Value, fallback: bool| value.as_bool().unwrap_or(fallback);
        Policy {
            automatic_publishing_enabled: flag(
                &stored["automaticPublishingEnabled"],
                d.automatic_publishing_enabled,
            ),
            automatic_sources: Source::ALL
                .into_iter()
                .filter(|s| stored["automaticSources"][s.as_str()].as_bool() == Some(true))
                .collect(),
            allow_warnings: flag(&stored["allowWarnings"], d.allow_warnings),
            maximum_candidate_age_ms: integer(
                &stored["maximumCandidateAgeMs"],
                d.maximum_candidate_age_ms,
                60_000.0,
                7.0 * 24.0 * 60.0 * 60.0 * 1000.0,
            ),
            minimum_absolute_price_change: number(
                &stored["minimumAbsolutePriceChange"],
                d.minimum_absolute_price_change,
                0.0,
                10_000.0,
            ),
            minimum_relative_price_change_percent: number(
                &stored["minimumRelativePriceChangePercent"],
                d.minimum_relative_price_change_percent,
                0.0,
                100.0,
            ),
            staged_micro_batch_maximum: integer(
                &stored["stagedMicroBatchMaximum"],
                d.staged_micro_batch_maximum,
                1.0,
                750.0,
            ),
            staged_flush_window_ms: integer(
                &stored["stagedFlushWindowMs"],
                d.staged_flush_window_ms,
                1_000.0,
                3_600_000.0,
            ),
        }
    }
}

impl Policy {
    /// The policy as Node stores it in a publication's `config_json`, every source named and whole
    /// numbers written without a fraction.
    pub fn document(&self) -> Value {
        let sources: serde_json::Map<String, Value> = Source::ALL
            .into_iter()
            .map(|s| {
                (
                    s.as_str().to_owned(),
                    self.automatic_sources.contains(&s).into(),
                )
            })
            .collect();
        serde_json::json!({
            "automaticPublishingEnabled": self.automatic_publishing_enabled,
            "automaticSources": sources,
            "allowWarnings": self.allow_warnings,
            "maximumCandidateAgeMs": self.maximum_candidate_age_ms,
            "minimumAbsolutePriceChange": js_number(self.minimum_absolute_price_change),
            "minimumRelativePriceChangePercent": js_number(self.minimum_relative_price_change_percent),
            "stagedMicroBatchMaximum": self.staged_micro_batch_maximum,
            "stagedFlushWindowMs": self.staged_flush_window_ms,
        })
    }
}

/// A number as JavaScript writes it: a whole one without a fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// Why a candidate is held back, in the order the policy finds them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    AutomaticPublishingDisabled,
    SourceNotEnabled,
    PricingError,
    PricingWarning,
    InvalidQuantityDelta,
    InventoryDeltaAlreadyConsumed,
    CandidateStale,
    MissingPrice,
    InvalidPrice,
    MissingPreviousPrice,
    UnchangedPrice,
    BelowMinimumChange,
    MissingProductMetadata,
    PricingCandidateAlreadyUsed,
    CsvQuantityDeltaRequiresReview,
    InventoryDeltaAmbiguous,
    InventoryDeltaAlreadyPlanned,
}

/// Adds `reason` once.
pub fn add(reasons: &mut Vec<Reason>, reason: Reason) {
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

/// What the price was decided from, as far as publishing trusts a warned price.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Basis {
    pub modeled: bool,
    pub forecast_available: bool,
    pub unprofitable: bool,
}

impl Basis {
    /// From a pricing decision as pricing details store it.
    pub fn of(decision: &Value) -> Option<Basis> {
        decision.as_object()?;
        Some(Basis {
            modeled: decision["basis"].as_str() == Some("modeled"),
            forecast_available: decision["forecastStatus"].as_str() != Some("unavailable"),
            unprofitable: decision["unprofitable"].as_bool().unwrap_or(false),
        })
    }
}

/// A priced SKU that might be published.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub source: Source,
    pub batch_number: i32,
    pub sku: i32,
    pub price: Option<f64>,
    pub previous_price: Option<f64>,
    /// Whole units, as JavaScript holds them (a fraction is invalid).
    pub quantity_delta: f64,
    pub inventory_delta_consumed: bool,
    pub is_new_inventory: bool,
    pub priced_at: DateTime<Utc>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub decision: Option<Basis>,
    pub market_price: Option<f64>,
}

/// Whether the candidate may be published, and its prices to the cent.
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub eligible: bool,
    pub reasons: Vec<Reason>,
    pub rounded_price: Option<f64>,
    pub rounded_previous_price: Option<f64>,
    pub absolute_price_change: Option<f64>,
    pub relative_price_change_percent: Option<f64>,
}

/// `Math.round((value + Number.EPSILON) * 100) / 100`.
pub fn round_to_cents(value: f64) -> f64 {
    js_round((value + f64::EPSILON) * 100.0) as f64 / 100.0
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

/// `createPricingCandidateKey`.
pub fn candidate_key(batch_number: i32, sku: i32, priced_at: DateTime<Utc>) -> String {
    format!(
        "pricing-result:{batch_number}:{sku}:{}",
        priced_at.to_rfc3339_opts(SecondsFormat::Millis, true)
    )
}

/// `createInventoryDeltaKey`.
pub fn inventory_delta_key(batch_number: i32, sku: i32) -> String {
    format!("inventory-batch-item:{batch_number}:{sku}")
}

/// Whether the candidate may be published under `policy` at `now`; `automatic` adds the checks
/// a publication nobody asked for must pass.
pub fn evaluate(
    candidate: &Candidate,
    policy: &Policy,
    now: DateTime<Utc>,
    automatic: bool,
) -> Decision {
    let mut reasons = Vec::new();
    if automatic {
        if !policy.automatic_publishing_enabled {
            add(&mut reasons, Reason::AutomaticPublishingDisabled);
        }
        if !policy.automatic_sources.contains(&candidate.source) {
            add(&mut reasons, Reason::SourceNotEnabled);
        }
    }
    if !candidate.errors.is_empty() {
        add(&mut reasons, Reason::PricingError);
    }
    let trusted_despite_warnings = candidate.decision.is_some_and(|d| {
        d.modeled
            && d.forecast_available
            && !d.unprofitable
            && positive(candidate.market_price).is_some()
    });
    if !policy.allow_warnings
        && !candidate.warnings.is_empty()
        && !trusted_despite_warnings
        && candidate.quantity_delta <= 0.0
    {
        add(&mut reasons, Reason::PricingWarning);
    }
    if candidate.quantity_delta.fract() != 0.0 || !candidate.quantity_delta.is_finite() {
        add(&mut reasons, Reason::InvalidQuantityDelta);
    }
    if candidate.quantity_delta != 0.0 && candidate.inventory_delta_consumed {
        add(&mut reasons, Reason::InventoryDeltaAlreadyConsumed);
    }
    let age_ms = (now - candidate.priced_at).num_milliseconds();
    if age_ms < 0 || age_ms > policy.maximum_candidate_age_ms {
        add(&mut reasons, Reason::CandidateStale);
    }

    let mut rounded_price = None;
    match candidate.price {
        None => add(&mut reasons, Reason::MissingPrice),
        Some(price) if positive(Some(price)).is_none() => add(&mut reasons, Reason::InvalidPrice),
        Some(price) => rounded_price = Some(round_to_cents(price)),
    }
    let rounded_previous_price = positive(candidate.previous_price).map(round_to_cents);
    if rounded_previous_price.is_none()
        && candidate.quantity_delta == 0.0
        && !candidate.is_new_inventory
    {
        add(&mut reasons, Reason::MissingPreviousPrice);
    }
    let (mut absolute_price_change, mut relative_price_change_percent) = (None, None);
    if let (Some(price), Some(previous)) = (rounded_price, rounded_previous_price) {
        let change = round_to_cents((price - previous).abs());
        let relative = change / previous * 100.0;
        absolute_price_change = Some(change);
        relative_price_change_percent = Some(relative);
        if change == 0.0 {
            add(&mut reasons, Reason::UnchangedPrice);
        } else if change < policy.minimum_absolute_price_change
            || relative < policy.minimum_relative_price_change_percent
        {
            add(&mut reasons, Reason::BelowMinimumChange);
        }
    }
    Decision {
        eligible: reasons.is_empty(),
        reasons,
        rounded_price,
        rounded_previous_price,
        absolute_price_change,
        relative_price_change_percent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().expect("a test time")
    }

    fn now() -> DateTime<Utc> {
        at("2026-08-05T12:00:00.000Z")
    }

    fn enabled() -> Policy {
        Policy {
            automatic_publishing_enabled: true,
            automatic_sources: vec![Source::PendingInventory, Source::Seller],
            ..Policy::default()
        }
    }

    fn candidate() -> Candidate {
        Candidate {
            source: Source::Seller,
            batch_number: 90,
            sku: 5199433,
            price: Some(24.99),
            previous_price: Some(24.57),
            quantity_delta: 0.0,
            inventory_delta_consumed: false,
            is_new_inventory: false,
            priced_at: at("2026-08-05T11:30:00.000Z"),
            errors: Vec::new(),
            warnings: Vec::new(),
            decision: None,
            market_price: None,
        }
    }

    #[test]
    fn automatic_publication_is_disabled_by_default() {
        let d = evaluate(&candidate(), &Policy::default(), now(), true);
        assert!(!d.eligible);
        assert_eq!(
            d.reasons,
            [
                Reason::AutomaticPublishingDisabled,
                Reason::SourceNotEnabled
            ]
        );
    }

    #[test]
    fn eligible_seller_price_changes_are_rounded_and_accepted() {
        let d = evaluate(
            &Candidate {
                price: Some(24.994),
                ..candidate()
            },
            &enabled(),
            now(),
            true,
        );
        assert!(d.eligible);
        assert_eq!(
            (d.rounded_price, d.rounded_previous_price),
            (Some(24.99), Some(24.57))
        );
        assert!(d.reasons.is_empty());
    }

    #[test]
    fn new_inventory_can_publish_without_a_previous_price() {
        let new = Candidate {
            source: Source::PendingInventory,
            previous_price: None,
            quantity_delta: 3.0,
            ..candidate()
        };
        let d = evaluate(&new, &enabled(), now(), true);
        assert!(d.eligible);
    }

    #[test]
    fn stale_candidates_and_consumed_inventory_deltas_require_review() {
        let stale = Candidate {
            source: Source::PendingInventory,
            previous_price: None,
            quantity_delta: 3.0,
            inventory_delta_consumed: true,
            warnings: vec!["No market price available".into()],
            priced_at: at("2026-08-05T09:00:00.000Z"),
            ..candidate()
        };
        let d = evaluate(&stale, &enabled(), now(), true);
        assert_eq!(
            d.reasons,
            [
                Reason::InventoryDeltaAlreadyConsumed,
                Reason::CandidateStale
            ]
        );
    }

    #[test]
    fn a_warned_price_publishes_only_when_forecast_anchored_and_profitable() {
        let forecast = Basis {
            modeled: true,
            forecast_available: true,
            unprofitable: false,
        };
        let fallback = Basis {
            forecast_available: false,
            ..forecast
        };
        let reference = Basis {
            modeled: false,
            forecast_available: false,
            unprofitable: false,
        };
        let warned = |change: &dyn Fn(&mut Candidate), policy: &Policy| {
            let mut c = Candidate {
                warnings: vec!["Suggested price below minimum. Using minimum price.".into()],
                decision: Some(forecast),
                market_price: Some(26.5),
                ..candidate()
            };
            change(&mut c);
            evaluate(&c, policy, now(), true)
        };
        let held = [Reason::PricingWarning];
        assert!(warned(&|_| {}, &enabled()).eligible, "floored forecast");
        assert_eq!(
            warned(&|c| c.market_price = None, &enabled()).reasons,
            held,
            "no market price"
        );
        assert_eq!(
            warned(&|c| c.decision = Some(fallback), &enabled()).reasons,
            held,
            "fallback"
        );
        assert_eq!(
            warned(&|c| c.decision = Some(reference), &enabled()).reasons,
            held,
            "reference"
        );
        assert_eq!(
            warned(
                &|c| c.decision = Some(Basis {
                    unprofitable: true,
                    ..forecast
                }),
                &enabled()
            )
            .reasons,
            held,
            "loss-limiting price"
        );
        assert_eq!(
            warned(&|c| c.decision = None, &enabled()).reasons,
            held,
            "no decision"
        );
        let allow = Policy {
            allow_warnings: true,
            ..enabled()
        };
        assert!(
            warned(&|c| c.decision = Some(reference), &allow).eligible,
            "allowed warnings"
        );
        let addition = |c: &mut Candidate| {
            c.source = Source::PendingInventory;
            c.previous_price = None;
            c.quantity_delta = 3.0;
            c.decision = Some(reference);
        };
        assert!(
            warned(&addition, &enabled()).eligible,
            "inventory additions"
        );
    }

    #[test]
    fn previous_price_percentages_do_not_block_valid_cent_changes() {
        let up = evaluate(
            &Candidate {
                previous_price: Some(0.01),
                price: Some(0.03),
                ..candidate()
            },
            &enabled(),
            now(),
            true,
        );
        let down = evaluate(
            &Candidate {
                previous_price: Some(0.02),
                price: Some(0.01),
                ..candidate()
            },
            &enabled(),
            now(),
            true,
        );
        assert!(up.eligible && down.eligible);
    }

    #[test]
    fn an_exact_one_cent_change_meets_the_one_cent_minimum() {
        let d = evaluate(
            &Candidate {
                previous_price: Some(0.24),
                price: Some(0.23),
                ..candidate()
            },
            &enabled(),
            now(),
            true,
        );
        assert_eq!(d.absolute_price_change, Some(0.01));
        assert!(d.eligible);
    }

    #[test]
    fn candidate_identities_are_stable() {
        let c = candidate();
        assert_eq!(
            candidate_key(c.batch_number, c.sku, c.priced_at),
            "pricing-result:90:5199433:2026-08-05T11:30:00.000Z"
        );
        assert_eq!(
            inventory_delta_key(90, 5199433),
            "inventory-batch-item:90:5199433"
        );
    }

    #[test]
    fn stored_policies_read_as_node_normalizes_them() {
        let p = Policy::of(&serde_json::json!({
            "automaticPublishingEnabled": true,
            "automaticSources": { "continuous": true, "seller": "yes" },
            "maximumCandidateAgeMs": 86_400_000,
            "stagedMicroBatchMaximum": 250.5,
            "minimumRelativePriceChangePercent": 101
        }));
        assert!(p.automatic_publishing_enabled);
        assert_eq!(p.automatic_sources, [Source::Continuous]);
        assert_eq!(p.maximum_candidate_age_ms, 86_400_000);
        assert_eq!(p.staged_micro_batch_maximum, 250);
        assert_eq!(p.minimum_relative_price_change_percent, 0.0);
    }
}
