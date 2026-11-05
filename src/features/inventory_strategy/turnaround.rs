//! The turnaround a capital cycle assumes: the seller's manual days, or the days observed in the
//! saved reinvestment report when that evidence is fresh, seller-scoped and broad enough. Ported
//! from `turnaroundStrategy.ts` and its types; the JSON keeps the Node app's shape.
use std::collections::HashSet;

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use super::{
    collate,
    reinvestment::{self, AllocationState, Report, Sample},
};
use crate::features::inventory_economics::ledger::{assumptions::js_to_fixed, proceeds::iso};

pub struct EvidencePolicy {
    pub observation_days: f64,
    pub maximum_report_age_hours: f64,
    pub maximum_order_coverage_age_hours: f64,
    pub minimum_completed_purchases: usize,
    pub confident_completed_purchases: usize,
    pub minimum_sale_span_days: f64,
    pub supported_order_search_range: &'static str,
}

pub const EVIDENCE_POLICY: EvidencePolicy = EvidencePolicy {
    observation_days: 90.0,
    maximum_report_age_hours: 24.0,
    maximum_order_coverage_age_hours: 24.0,
    minimum_completed_purchases: 5,
    confident_completed_purchases: 20,
    minimum_sale_span_days: 14.0,
    supported_order_search_range: "LastThreeMonths",
};

const DAY: f64 = 86_400_000.0;
const HOUR: f64 = 3_600_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Manual,
    Observed,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "manual" => Some(Mode::Manual),
            "observed" => Some(Mode::Observed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Manual => "manual",
            Mode::Observed => "observed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub seller_key: String,
    pub product_line_id: Option<i64>,
    pub mode: Mode,
    pub manual_turnaround_days: f64,
    pub updated_at: Option<String>,
}

pub const DEFAULT_MODE: Mode = Mode::Observed;
pub const DEFAULT_MANUAL_TURNAROUND_DAYS: f64 = 28.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Seller,
    ProductLine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Attribution {
    Seller,
    ProductLine,
    SellerSubstitutedForSparseLine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSummary {
    pub scope: Scope,
    pub source_product_line_id: Option<i64>,
    pub attribution: Attribution,
    pub report_as_of: String,
    pub source_fingerprint: String,
    pub observation_from: Option<String>,
    pub observation_through: Option<String>,
    pub completed_purchase_count: usize,
    pub completed_cents: i64,
    pub waiting_cents: i64,
    pub oldest_waiting_days: Option<f64>,
    pub eligible_proceeds_cents: i64,
    pub unallocated_proceeds_cents: i64,
    pub oldest_unallocated_days: Option<f64>,
    pub reinvested_percent: Option<f64>,
    pub completion_coverage_percent: Option<f64>,
    pub typical_days: Option<f64>,
    pub slower_days: Option<f64>,
    pub order_coverage_finished_at: Option<String>,
    pub order_observed_from: Option<String>,
    pub order_observed_through: Option<String>,
    pub confidence: Confidence,
    pub limitations: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectiveSource {
    Manual,
    ObservedProductLine,
    ObservedSeller,
    ManualFallback,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub setting: Setting,
    pub effective_days: f64,
    pub effective_source: EffectiveSource,
    pub fallback_reasons: Vec<String>,
    pub evidence: Option<EvidenceSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Eligible,
    Sparse,
    Ineligible,
}

struct Evaluation {
    status: Status,
    reasons: Vec<String>,
    evidence: Option<EvidenceSummary>,
}

fn instant(value: Option<&str>) -> Option<f64> {
    value
        .filter(|v| !v.is_empty())
        .and_then(|v| reinvestment::instant(v, "").ok())
        .map(|ms| ms as f64)
}

fn iso_at(ms: f64) -> Option<String> {
    DateTime::from_timestamp_millis(ms as i64).map(iso)
}

fn days(sample: &Sample) -> f64 {
    sample.turnaround_days.unwrap_or(0.0)
}

/// The completed dollar-weighted mean of the cycles' days.
fn weighted_mean(samples: &[&Sample]) -> Option<f64> {
    let total: i64 = samples.iter().map(|s| s.amount_cents).sum();
    (total != 0).then(|| {
        samples
            .iter()
            .fold(0.0, |sum, s| sum + s.amount_cents as f64 * days(s))
            / total as f64
    })
}

/// The dollar-weighted p90 of the cycles' days: the first cycle, slowest last, at which 90% of
/// the dollars (rounded up to the cent) have come back.
fn weighted_p90(samples: &[&Sample]) -> Option<f64> {
    let mut ordered = samples.to_vec();
    ordered.sort_by(|left, right| {
        days(left)
            .partial_cmp(&days(right))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| collate::compare(&left.sample_key, &right.sample_key))
    });
    let total: i128 = ordered.iter().map(|s| s.amount_cents as i128).sum();
    if total == 0 {
        return None;
    }
    let target = (total * 90 + 99) / 100;
    let mut cumulative = 0i128;
    for sample in &ordered {
        cumulative += sample.amount_cents as i128;
        if cumulative >= target {
            return sample.turnaround_days;
        }
    }
    ordered.last().and_then(|s| s.turnaround_days)
}

fn setting_for(seller_key: &str, product_line_id: Option<i64>, settings: &[Setting]) -> Setting {
    let exact = settings
        .iter()
        .find(|s| s.seller_key == seller_key && s.product_line_id == product_line_id);
    let inherited = product_line_id.and_then(|_| {
        settings
            .iter()
            .find(|s| s.seller_key == seller_key && s.product_line_id.is_none())
    });
    let source = exact.or(inherited);
    Setting {
        seller_key: seller_key.to_string(),
        product_line_id,
        mode: source.map_or(DEFAULT_MODE, |s| s.mode),
        manual_turnaround_days: source
            .map_or(DEFAULT_MANUAL_TURNAROUND_DAYS, |s| s.manual_turnaround_days),
        updated_at: source.and_then(|s| s.updated_at.clone()),
    }
}

fn evaluate(
    report: Option<&Report>,
    recovery_error: Option<&str>,
    seller_key: &str,
    product_line_id: Option<i64>,
    now_ms: f64,
) -> Evaluation {
    let Some(report) = report else {
        return Evaluation {
            status: Status::Ineligible,
            reasons: vec!["No saved reinvestment evidence is available.".into()],
            evidence: None,
        };
    };
    let policy = &EVIDENCE_POLICY;
    let mut reasons: Vec<String> = Vec::new();
    // Evidence gaps that strategy fills by assumption; they are reported, never blocking.
    let mut notes: Vec<String> = Vec::new();
    let as_of = instant(Some(&report.as_of));
    if recovery_error.is_some_and(|e| !e.is_empty()) {
        reasons.push("Current evidence could not be rebuilt; a saved recovery report cannot select observed mode.".into());
    }
    if report.rule_version != reinvestment::RULE_VERSION {
        reasons.push("The saved report predates the current reinvestment rule.".into());
    }
    if report.seller_key != seller_key {
        reasons.push("The saved report belongs to a different seller.".into());
    }
    if as_of.is_none_or(|at| at > now_ms || now_ms - at > policy.maximum_report_age_hours * HOUR) {
        reasons.push("The report as-of time is missing, future, or older than 24 hours.".into());
    }
    let order_coverage = report.order_coverage.as_ref();
    match order_coverage {
        None => notes.push(
            "No complete Seller Portal order scan is available; proceeds are taken from the orders observed.".into(),
        ),
        Some(coverage) => {
            let finished_at = instant(Some(&coverage.finished_at));
            let incomplete = coverage.status != "complete"
                || coverage.source != "tcgplayer_api"
                || coverage.search_range.as_deref() != Some(policy.supported_order_search_range)
                || coverage
                    .expected_total
                    .is_none_or(|expected| coverage.next_offset < expected || coverage.orders_observed < expected)
                || !coverage.gaps.is_empty();
            if incomplete {
                notes.push(
                    "The latest Seller Portal order scan is incomplete; proceeds are taken from the orders observed."
                        .into(),
                );
            }
            if finished_at
                .is_none_or(|at| at > now_ms || now_ms - at > policy.maximum_order_coverage_age_hours * HOUR)
            {
                notes.push("The Seller Portal order scan is older than 24 hours.".into());
            }
        }
    }
    let currencies: Vec<_> = report
        .currencies
        .iter()
        .filter(|c| {
            c.eligible_proceeds_cents != 0
                || c.completed_cents != 0
                || c.waiting_cents != 0
                || c.unallocated_proceeds_cents != 0
                || c.outside_funding_supplied_cents != 0
        })
        .collect();
    if currencies.len() != 1 || currencies[0].currency != "USD" {
        reasons.push(
            "Observed strategy timing requires one USD proceeds pool; currencies are never mixed."
                .into(),
        );
    }
    let usd = currencies.iter().find(|c| c.currency == "USD");
    if usd.is_some_and(|usd| {
        usd.waiting_cents > 0
            || usd.unallocated_proceeds_cents > 0
            || usd.reinvested_percent != Some(100.0)
            || usd.completion_coverage_percent != Some(100.0)
    }) {
        notes.push(
            "Some proceeds are still waiting or unallocated; only completed cycles are measured."
                .into(),
        );
    }
    if report.coverage.unknown_proceeds_order_count > 0 {
        notes.push("Some orders lack proceeds evidence and are left out.".into());
    }
    if report.coverage.unknown_cost_receipt_count > 0 {
        notes.push("Some received inventory has no cost yet and is left out.".into());
    }

    let scoped: Vec<&Sample> = report
        .samples
        .iter()
        .filter(|s| {
            s.currency == "USD" && product_line_id.is_none_or(|line| s.product_line_id == line)
        })
        .collect();
    let completed_lifetime: Vec<&Sample> = scoped
        .iter()
        .copied()
        .filter(|s| s.state == AllocationState::Completed)
        .collect();
    let waiting_lifetime: Vec<&Sample> = scoped
        .iter()
        .copied()
        .filter(|s| s.state == AllocationState::Waiting)
        .collect();
    if !waiting_lifetime.is_empty() {
        notes.push(
            "Some sale proceeds are still waiting for publication and are not yet cycles.".into(),
        );
    }
    let completed: Vec<&Sample> = match as_of {
        None => Vec::new(),
        Some(as_of) => {
            let cohort_start = as_of - policy.observation_days * DAY;
            completed_lifetime
                .iter()
                .copied()
                .filter(|s| {
                    instant(Some(&s.sold_at)).is_some_and(|at| at >= cohort_start && at <= as_of)
                })
                .collect()
        }
    };
    let completed_cents: i64 = completed.iter().map(|s| s.amount_cents).sum();
    let waiting_cents: i64 = waiting_lifetime.iter().map(|s| s.amount_cents).sum();
    let oldest_waiting_days = (!waiting_lifetime.is_empty()).then(|| {
        waiting_lifetime
            .iter()
            .map(|s| s.waiting_age_days.unwrap_or(0.0))
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let purchases = completed
        .iter()
        .map(|s| s.purchase_reference.as_str())
        .collect::<HashSet<_>>()
        .len();
    let sold_times: Vec<f64> = completed
        .iter()
        .filter_map(|s| instant(Some(&s.sold_at)))
        .collect();
    let published_times: Vec<f64> = completed
        .iter()
        .filter_map(|s| instant(s.published_at.as_deref()))
        .collect();
    let earliest = |times: &[f64]| times.iter().copied().reduce(f64::min);
    let latest = |times: &[f64]| times.iter().copied().reduce(f64::max);
    let observation_from = earliest(&sold_times);
    let observation_through = latest(&sold_times);
    if latest(&published_times).is_some_and(|at| now_ms - at > policy.observation_days * DAY) {
        notes.push("The selected cohort has no recently completed replacement publication.".into());
    }

    let mut limitations = vec![
        "Costs, proceeds, and funding dates are estimated by the strategy assumptions where evidence is missing; figures are directional.".to_string(),
        "Typical is a completed dollar-weighted mean of the last 90 days of cycles.".into(),
        "Slower is the completed dollar-weighted p90 scenario, not a confidence bound.".into(),
    ];
    limitations.extend(notes);
    let mut evidence = EvidenceSummary {
        scope: if product_line_id.is_none() {
            Scope::Seller
        } else {
            Scope::ProductLine
        },
        source_product_line_id: product_line_id,
        attribution: if product_line_id.is_none() {
            Attribution::Seller
        } else {
            Attribution::ProductLine
        },
        report_as_of: report.as_of.clone(),
        source_fingerprint: report.source_fingerprint.clone(),
        observation_from: observation_from.and_then(iso_at),
        observation_through: observation_through.and_then(iso_at),
        completed_purchase_count: purchases,
        completed_cents,
        waiting_cents,
        oldest_waiting_days,
        eligible_proceeds_cents: usd.map_or(0, |u| u.eligible_proceeds_cents),
        unallocated_proceeds_cents: usd.map_or(0, |u| u.unallocated_proceeds_cents),
        oldest_unallocated_days: usd.and_then(|u| u.oldest_unallocated_days),
        reinvested_percent: usd.and_then(|u| u.reinvested_percent),
        completion_coverage_percent: usd.and_then(|u| u.completion_coverage_percent),
        typical_days: weighted_mean(&completed),
        slower_days: weighted_p90(&completed),
        order_coverage_finished_at: order_coverage.map(|c| c.finished_at.clone()),
        order_observed_from: order_coverage.and_then(|c| c.observed_from.clone()),
        order_observed_through: order_coverage.and_then(|c| c.observed_through.clone()),
        confidence: if purchases >= policy.confident_completed_purchases {
            Confidence::High
        } else if purchases >= policy.minimum_completed_purchases {
            Confidence::Medium
        } else if !completed.is_empty() {
            Confidence::Low
        } else {
            Confidence::Unavailable
        },
        limitations,
    };
    let no_recent_completed = completed.is_empty();
    if product_line_id.is_some()
        && no_recent_completed
        && completed_lifetime.is_empty()
        && waiting_lifetime.is_empty()
        && reasons.is_empty()
    {
        return Evaluation {
            status: Status::Sparse,
            reasons: vec!["This product line has no attributed replacement cycles.".into()],
            evidence: Some(evidence),
        };
    }
    if product_line_id.is_some() && no_recent_completed && !completed_lifetime.is_empty() {
        reasons.push("This product line has completed cycles, but none occurred in the current 90-day cohort.".into());
    }
    let span_days = match (observation_from, observation_through) {
        (Some(from), Some(through)) => (through - from) / DAY,
        _ => 0.0,
    };
    let sparse =
        purchases < policy.minimum_completed_purchases || span_days < policy.minimum_sale_span_days;
    let (minimum, span, span_text) = (
        policy.minimum_completed_purchases,
        policy.minimum_sale_span_days,
        js_to_fixed(span_days, 1),
    );
    if sparse && reasons.is_empty() && product_line_id.is_some() {
        return Evaluation {
            status: Status::Sparse,
            reasons: vec![format!(
                "This product line needs {minimum} completed purchases spanning at least {span} sale days; it has {purchases} across {span_text} days."
            )],
            evidence: Some(evidence),
        };
    }
    if sparse {
        reasons.push(format!(
            "Observed mode needs {minimum} completed purchases spanning at least {span} sale days; this cohort has {purchases} across {span_text} days."
        ));
    }
    if !reasons.is_empty() {
        evidence.confidence = Confidence::Unavailable;
        return Evaluation {
            status: Status::Ineligible,
            reasons,
            evidence: Some(evidence),
        };
    }
    Evaluation {
        status: Status::Eligible,
        reasons: Vec::new(),
        evidence: Some(evidence),
    }
}

/// The turnaround for a seller, or one of its product lines: the setting that applies (the line's,
/// else the seller's, else the default), and the observed days when observed mode is set and the
/// evidence allows it. A sparse line borrows the seller's evidence.
pub fn select(
    seller_key: &str,
    product_line_id: Option<i64>,
    settings: &[Setting],
    report: Option<&Report>,
    recovery_error: Option<&str>,
    now_ms: f64,
) -> Selection {
    let setting = setting_for(seller_key, product_line_id, settings);
    let mut result = evaluate(report, recovery_error, seller_key, product_line_id, now_ms);
    let mut source = if product_line_id.is_none() {
        EffectiveSource::ObservedSeller
    } else {
        EffectiveSource::ObservedProductLine
    };
    if let (Status::Sparse, Some(line)) = (result.status, product_line_id) {
        let seller = evaluate(report, recovery_error, seller_key, None, now_ms);
        match seller.evidence {
            Some(mut evidence) if seller.status == Status::Eligible => {
                evidence.attribution = Attribution::SellerSubstitutedForSparseLine;
                evidence.limitations.push(format!(
                    "Seller-wide timing is used because product line {line} has sparse evidence."
                ));
                result = Evaluation {
                    status: seller.status,
                    reasons: seller.reasons,
                    evidence: Some(evidence),
                };
                source = EffectiveSource::ObservedSeller;
            }
            _ => {
                result.status = Status::Ineligible;
                result.reasons.extend(seller.reasons);
            }
        }
    }
    let observed_days = result
        .evidence
        .as_ref()
        .and_then(|e| e.typical_days)
        .filter(|_| result.status == Status::Eligible);
    let manual = setting.mode == Mode::Manual;
    Selection {
        effective_days: match observed_days {
            Some(days) if !manual => days,
            _ => setting.manual_turnaround_days,
        },
        effective_source: match observed_days {
            _ if manual => EffectiveSource::Manual,
            Some(_) => source,
            None => EffectiveSource::ManualFallback,
        },
        fallback_reasons: if manual || observed_days.is_some() {
            Vec::new()
        } else {
            result.reasons
        },
        evidence: result.evidence,
        setting,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SELLER: &str = "synthetic-turnaround";
    const LINE: i64 = 101;

    fn now() -> f64 {
        instant(Some("2026-09-08T18:00:00.000Z")).unwrap()
    }

    fn sample(purchase: i64, days: i64, amount_cents: i64) -> serde_json::Value {
        let sold_at = DAY * (purchase as f64) + instant(Some("2026-08-15T00:00:00.000Z")).unwrap();
        json!({
            "sampleKey": format!("{purchase}-{days}"),
            "currency": "USD",
            "orderNumber": format!("order-{purchase}"),
            "purchaseReference": format!("purchase-{purchase}"),
            "receiptId": purchase * 10 + days,
            "productLineId": LINE,
            "amountCents": amount_cents,
            "soldAt": iso_at(sold_at),
            "fundingAt": iso_at(sold_at),
            "publishedAt": iso_at(sold_at + days as f64 * DAY),
            "state": "completed",
            "timingBasis": "known_funding",
            "proceedsProvenance": "actual",
            "costProvenance": "actual",
            "fundingProvenance": "actual",
            "turnaroundDays": days,
            "explanation": "Synthetic pooled attribution.",
            "sourceIdentities": [],
        })
    }

    fn report() -> Report {
        let samples: Vec<_> = (0..20)
            .flat_map(|i| [sample(i, 10, 6_000), sample(i, 20, 4_000)])
            .collect();
        serde_json::from_value(json!({
            "sellerKey": SELLER,
            "asOf": "2026-09-08T17:00:00.000Z",
            "ruleVersion": "pooled-proceeds/v2",
            "sourceFingerprint": "a".repeat(64),
            "currentCorrectedView": true,
            "datePrecision": "timestamp_sales_date_funding",
            "currencies": [{
                "currency": "USD", "eligibleProceedsCents": 200_000, "negativeProceedsCents": 0,
                "completedCents": 200_000, "waitingCents": 0, "unallocatedProceedsCents": 0,
                "reservedOrWithdrawnCents": 0, "unsupportedFundingAdjustmentCents": 0,
                "outsideFundingUsedCents": 0, "outsideFundingSuppliedCents": 0,
                "outsideDeficitSettlementCents": 0, "outsideAvailableCents": 0,
                "outsideReservedOrWithdrawnCents": 0, "outstandingNegativeDeficitCents": 0,
                "unresolvedPurchaseCostCents": 0, "reinvestedPercent": 100, "completionCoveragePercent": 100,
                "completedDollarWeightedMeanDays": 14, "completedWeightedMedianDays": 10,
                "completedWeightedP90Days": 20, "waitingDollarWeightedAgeDays": null, "oldestWaitingDays": null,
                "unallocatedDollarWeightedAgeDays": null, "oldestUnallocatedDays": null,
            }],
            "samples": samples,
            "unsupportedPurchaseFunding": [],
            "excluded": [{ "reason": "Orders without complete reusable-proceeds evidence", "count": 1 }],
            "coverage": {
                "observedOrderCount": 21, "eligibleOrderCount": 20, "unknownProceedsOrderCount": 1,
                "purchaseCount": 20, "costedReceiptCount": 40, "unknownCostReceiptCount": 0,
                "unknownProceeds": [{ "soldAt": "2026-05-01T00:00:00.000Z" }], "unknownCosts": [],
            },
            "orderCoverage": {
                "runId": "run-1", "source": "tcgplayer_api", "status": "complete", "searchRange": "LastThreeMonths",
                "finishedAt": "2026-09-08T17:30:00.000Z", "nextOffset": 20, "expectedTotal": 20,
                "ordersObserved": 20, "detailsRecorded": 0, "observedFrom": "2026-08-15T00:00:00.000Z",
                "observedThrough": "2026-09-03T00:00:00.000Z", "gaps": [],
            },
            "convention": [],
        }))
        .expect("the Node report shape")
    }

    fn observed() -> Vec<Setting> {
        vec![Setting {
            seller_key: SELLER.into(),
            product_line_id: None,
            mode: Mode::Observed,
            manual_turnaround_days: 28.0,
            updated_at: iso_at(now()),
        }]
    }

    fn choose(line: Option<i64>, settings: &[Setting], report: &Report) -> Selection {
        select(SELLER, line, settings, Some(report), None, now())
    }

    fn limitations(selection: &Selection) -> String {
        selection
            .evidence
            .as_ref()
            .map(|e| e.limitations.join(" "))
            .unwrap_or_default()
    }

    #[test]
    fn observed_turnaround_selects_fresh_seller_scoped_evidence_and_notes_assumed_gaps() {
        use crate::features::pricing::capital_cycle::{Economics, Portfolio, capital_cycle};
        let report = report();
        let cycle_days = |turnaround_days| {
            capital_cycle(
                100.0,
                20.0,
                Portfolio {
                    market_value: 100.0,
                    unit_count: 1.0,
                },
                Economics {
                    cost_basis_share_of_market: 0.5,
                    cost_basis_discount_per_unit: 0.0,
                    relative_overhead: 0.0,
                    static_overhead_per_unit: 0.0,
                    turnaround_days,
                },
            )
            .cycle_days
        };

        let selected = choose(None, &observed(), &report);
        assert_eq!(selected.effective_source, EffectiveSource::ObservedSeller);
        assert_eq!(selected.effective_days, 14.0);
        assert_eq!(selected.evidence.as_ref().unwrap().slower_days, Some(20.0));
        assert_eq!(cycle_days(selected.effective_days), 34.0);

        let sparse = choose(Some(202), &observed(), &report);
        assert_eq!(sparse.effective_source, EffectiveSource::ObservedSeller);
        assert_eq!(
            sparse.evidence.unwrap().attribution,
            Attribution::SellerSubstitutedForSparseLine
        );

        let manual_settings = vec![Setting {
            mode: Mode::Manual,
            ..observed()[0].clone()
        }];
        let manual = choose(None, &manual_settings, &report);
        assert_eq!(manual.effective_days, 28.0);
        assert_eq!(cycle_days(manual.effective_days), 48.0);

        let mut recent_unknown = report.clone();
        recent_unknown
            .coverage
            .unknown_proceeds
            .push(reinvestment::SoldAt {
                sold_at: Some("2026-09-01T00:00:00.000Z".into()),
            });
        recent_unknown.coverage.unknown_proceeds_order_count += 1;
        let recent_unknown = choose(None, &observed(), &recent_unknown);
        assert_eq!(
            recent_unknown.effective_source,
            EffectiveSource::ObservedSeller,
            "orders without proceeds are left out, not blocking"
        );
        assert!(
            limitations(&recent_unknown)
                .to_lowercase()
                .contains("lack proceeds evidence")
        );

        let mut waiting = report.clone();
        waiting.currencies[0].waiting_cents = 1;
        waiting.currencies[0].completion_coverage_percent = Some(99.0);
        let waiting = choose(None, &observed(), &waiting);
        assert_eq!(
            waiting.effective_source,
            EffectiveSource::ObservedSeller,
            "waiting proceeds are noted, not blocking"
        );
        assert!(
            limitations(&waiting)
                .to_lowercase()
                .contains("still waiting")
        );

        let mut other_currency = report.clone();
        other_currency
            .currencies
            .push(reinvestment::CurrencySummary {
                currency: "EUR".into(),
                ..report.currencies[0].clone()
            });
        assert!(
            choose(None, &observed(), &other_currency)
                .fallback_reasons
                .join(" ")
                .contains("currencies are never mixed")
        );
        let mut old_report = report.clone();
        old_report.rule_version = "pooled-proceeds/v1".into();
        assert_eq!(
            choose(None, &observed(), &old_report).effective_source,
            EffectiveSource::ManualFallback
        );

        let mut estimated = report.clone();
        for sample in &mut estimated.samples {
            sample.proceeds_provenance = reinvestment::Provenance::Estimated;
            sample.cost_provenance = reinvestment::Provenance::Estimated;
        }
        let estimated = choose(None, &observed(), &estimated);
        assert_eq!(
            estimated.effective_source,
            EffectiveSource::ObservedSeller,
            "estimated cost and proceeds are enough for strategy"
        );
        assert_eq!(
            estimated.evidence.unwrap().confidence,
            Confidence::High,
            "20 completed purchases is high confidence"
        );
        let mut sparse_line = report.clone();
        sparse_line.samples.truncate(4);
        assert_eq!(
            choose(Some(LINE), &observed(), &sparse_line).effective_source,
            EffectiveSource::ManualFallback
        );

        assert_eq!(
            select(
                SELLER,
                None,
                &observed(),
                Some(&report),
                Some("rebuild failed"),
                now()
            )
            .effective_source,
            EffectiveSource::ManualFallback
        );
        let another = vec![Setting {
            seller_key: "another-seller".into(),
            ..observed()[0].clone()
        }];
        assert_eq!(
            select("another-seller", None, &another, Some(&report), None, now()).effective_source,
            EffectiveSource::ManualFallback
        );
    }

    #[test]
    fn a_sparse_line_says_how_short_its_evidence_is() {
        let mut report = report();
        report.samples.truncate(4);
        let line = evaluate(Some(&report), None, SELLER, Some(LINE), now());
        assert_eq!(line.status, Status::Sparse);
        assert_eq!(
            line.reasons,
            [
                "This product line needs 5 completed purchases spanning at least 14 sale days; it has 2 across 1.0 days."
            ]
        );
        let none = select(SELLER, None, &[], None, None, now());
        assert_eq!(
            (none.effective_days, none.effective_source),
            (28.0, EffectiveSource::ManualFallback)
        );
        assert_eq!(
            none.fallback_reasons,
            ["No saved reinvestment evidence is available."]
        );
    }
}
