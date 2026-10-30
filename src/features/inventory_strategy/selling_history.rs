//! How the units the seller listed have sold: each listing episode (a publication, opening
//! balance, restock or correction) followed to its sales and removals, summarized by product line
//! with the days to sale and sell-through at fixed horizons. Units still listed are censored, not
//! dropped. Ported from `inventorySellingHistory.ts` and its types; the JSON keeps the Node app's
//! shape.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{collate, reinvestment};
use crate::features::inventory_economics::ledger::proceeds::iso;

pub const SELL_THROUGH_HORIZONS: [i64; 4] = [7, 30, 60, 90];
pub const WINDOWS: [i64; 4] = [90, 180, 365, 730];
const DAY_MS: f64 = 86_400_000.0;
const DETAIL_LIMIT: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub window_days: i64,
    pub product_line: Option<String>,
}

impl Default for Scope {
    fn default() -> Self {
        Scope {
            window_days: 180,
            product_line: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpisodeKind {
    ConfirmedPublication,
    OpeningBalance,
    PhysicalRestock,
    OrderQuantityCorrection,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForecastProvenance {
    Recorded,
    Estimated,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub episode_key: String,
    pub receipt_id: i64,
    pub sku: i64,
    pub product_line: String,
    pub product_name: String,
    pub kind: EpisodeKind,
    pub quantity: i64,
    pub listed_at: Option<String>,
    /// The forecast fields the pricing candidate carried, as the publication recorded them.
    pub forecast_evidence: Option<Value>,
    pub forecast_evidence_provenance: ForecastProvenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeKind {
    Sale,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeSource {
    SellerOrder,
    Cancellation,
    QuantityCorrection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub episode_key: String,
    pub kind: OutcomeKind,
    pub quantity: i64,
    pub happened_at: String,
    pub order_number: Option<String>,
    pub order_line_id: Option<String>,
    pub source: OutcomeSource,
}

/// How far the seller's orders are known: the latest order sync.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderCoverage {
    pub seller_key: String,
    pub source: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_through: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_total: Option<i64>,
    pub orders_observed: i64,
    pub details_recorded: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<i64>,
    pub gaps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OrderCoverage {
    /// No sync has run for the seller.
    pub fn not_started(seller_key: &str) -> Self {
        OrderCoverage {
            seller_key: seller_key.to_string(),
            source: "tcgplayer_api".into(),
            status: "not_started".into(),
            search_range: None,
            observed_from: None,
            observed_through: None,
            last_attempt_at: None,
            completed_at: None,
            expected_total: None,
            orders_observed: 0,
            details_recorded: 0,
            next_offset: None,
            gaps: Vec::new(),
            error: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub pending_quantity: i64,
    pub held_quantity: i64,
    pub affected_skus: Vec<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyUnlinked {
    pub quantity: i64,
    pub forecast_quantity: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedRemoval {
    pub quantity: i64,
    pub affected_skus: Vec<i64>,
}

/// Everything the report is built from, as the repository reads it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvidence {
    pub seller_key: String,
    pub scope: Scope,
    pub available_product_lines: Vec<String>,
    pub analysis_from: String,
    pub inventory_observed_at: Option<String>,
    pub order_coverage: OrderCoverage,
    pub episodes: Vec<Episode>,
    pub episode_count: i64,
    pub outcomes: Vec<Outcome>,
    pub outcome_count: i64,
    pub projection: Projection,
    pub opening_unknown_quantity: i64,
    pub legacy_unlinked: LegacyUnlinked,
    pub older_publication_quantity: i64,
    pub awaiting_cutoff_quantity: i64,
    pub unresolved_removal: UnresolvedRemoval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SellThroughStatus {
    Exact,
    UnsettledOutcomes,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SellThrough {
    pub days: i64,
    pub eligible_quantity: i64,
    pub sold_quantity: i64,
    pub rate: Option<f64>,
    pub status: SellThroughStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PercentileStatus {
    Estimable,
    NotReached,
    CompetingRemovals,
    UnsettledOutcomes,
    UncertainPresence,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub cohort_quantity: i64,
    pub known_listed_date_quantity: i64,
    pub unknown_listed_date_quantity: i64,
    pub sold_quantity: i64,
    pub sold_with_known_listed_date_quantity: i64,
    pub remaining_with_known_age_quantity: i64,
    pub remaining_with_uncertain_presence_quantity: i64,
    pub removed_quantity: i64,
    pub sold_only_average_days: Option<f64>,
    pub median_days_to_sale: Option<f64>,
    pub p90_days_to_sale: Option<f64>,
    pub percentile_status: PercentileStatus,
    pub sell_through: Vec<SellThrough>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLine {
    pub product_line: String,
    #[serde(flatten)]
    pub summary: Summary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSold {
    pub order_number: String,
    pub quantity: i64,
    pub sold_at: String,
    pub listed_days: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeDetail {
    pub episode_key: String,
    pub receipt_id: i64,
    pub sku: i64,
    pub product_line: String,
    pub product_name: String,
    pub kind: EpisodeKind,
    pub quantity: i64,
    pub listed_at: Option<String>,
    pub sold_quantity: i64,
    pub removed_quantity: i64,
    pub ledger_remaining_quantity: i64,
    pub remaining_age_days: Option<f64>,
    pub presence_uncertain: bool,
    pub forecast_evidence_provenance: ForecastProvenance,
    pub forecast_evidence: Option<Value>,
    pub orders: Vec<OrderSold>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub pending_projection_quantity: i64,
    pub held_projection_quantity: i64,
    pub unresolved_removal_quantity: i64,
    pub affected_removal_skus: usize,
    pub opening_unknown_quantity: i64,
    pub legacy_unlinked_quantity: i64,
    pub legacy_unlinked_forecast_quantity: i64,
    pub older_publication_quantity: i64,
    pub awaiting_cutoff_quantity: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    SellerNotConfigured,
    InventoryCoverageMissing,
    OrderCoverageIncomplete,
    HistoryBoundsExceeded,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub seller_key: String,
    pub scope: Scope,
    pub available_product_lines: Vec<String>,
    pub as_of: String,
    pub analysis_from: String,
    pub order_coverage: OrderCoverage,
    pub overall: Summary,
    pub product_lines: Vec<ProductLine>,
    pub details: Vec<EpisodeDetail>,
    pub detail_total: usize,
    pub detail_page: usize,
    pub detail_page_count: usize,
    pub coverage: Coverage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unavailable {
    pub seller_key: String,
    pub scope: Scope,
    pub available_product_lines: Vec<String>,
    pub reason: UnavailableReason,
    pub order_coverage: OrderCoverage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Report {
    Unavailable(Box<Unavailable>),
    Ready(Box<Ready>),
}

struct Prepared<'a> {
    episode: &'a Episode,
    listed_time: Option<f64>,
    outcomes: Vec<&'a Outcome>,
}

impl Prepared<'_> {
    fn used(&self) -> i64 {
        self.outcomes.iter().map(|o| o.quantity).sum()
    }

    fn of_kind(&self, kind: OutcomeKind) -> impl Iterator<Item = &&Outcome> {
        self.outcomes.iter().filter(move |o| o.kind == kind)
    }
}

fn time(value: &str) -> f64 {
    reinvestment::instant(value, "").map_or(f64::NAN, |ms| ms as f64)
}

fn days_between(start: f64, end: f64) -> f64 {
    ((end - start) / DAY_MS).max(0.0)
}

struct Observation {
    days: f64,
    quantity: i64,
    sold: bool,
}

/// Days at which the Kaplan-Meier survival of the cohort first falls to the target: units still
/// listed count as at risk until their age, then leave without selling.
fn reached_percentile(observations: &mut [Observation], target_survival: f64) -> Option<f64> {
    let mut at_risk: i64 = observations.iter().map(|o| o.quantity).sum();
    let mut survival = 1.0;
    observations.sort_by(|l, r| {
        l.days
            .partial_cmp(&r.days)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut index = 0;
    while index < observations.len() {
        let days = observations[index].days;
        let (mut sold, mut leaving) = (0, 0);
        while index < observations.len() && observations[index].days == days {
            if observations[index].sold {
                sold += observations[index].quantity;
            }
            leaving += observations[index].quantity;
            index += 1;
        }
        if sold > 0 && at_risk > 0 {
            survival *= 1.0 - sold as f64 / at_risk as f64;
        }
        if survival <= target_survival {
            return Some(days);
        }
        at_risk -= leaving;
    }
    None
}

fn prepare<'a>(
    episodes: &'a [Episode],
    outcomes: &'a [Outcome],
    as_of: f64,
) -> Result<Vec<Prepared<'a>>, String> {
    let mut by_episode: HashMap<&str, Vec<&Outcome>> = HashMap::new();
    for outcome in outcomes
        .iter()
        .filter(|o| time(&o.happened_at).partial_cmp(&as_of) != Some(std::cmp::Ordering::Greater))
    {
        by_episode
            .entry(outcome.episode_key.as_str())
            .or_default()
            .push(outcome);
    }
    episodes
        .iter()
        .filter(|e| e.listed_at.as_deref().is_none_or(|at| time(at) <= as_of))
        .map(|episode| {
            let prepared = Prepared {
                episode,
                listed_time: episode.listed_at.as_deref().map(time),
                outcomes: by_episode
                    .remove(episode.episode_key.as_str())
                    .unwrap_or_default(),
            };
            if prepared.used() > episode.quantity {
                return Err(format!(
                    "Selling history episode {} uses more units than its cohort.",
                    episode.episode_key
                ));
            }
            Ok(prepared)
        })
        .collect()
}

fn summarize(
    episodes: &[&Prepared],
    as_of: f64,
    uncertain_skus: &HashSet<i64>,
    unsettled_skus: &HashSet<i64>,
    has_unresolved_removal: bool,
) -> Summary {
    let cohort_quantity: i64 = episodes.iter().map(|e| e.episode.quantity).sum();
    let known: Vec<(&Prepared, f64)> = episodes
        .iter()
        .filter_map(|e| Some((*e, e.listed_time?)))
        .collect();
    let known_listed_date_quantity: i64 = known.iter().map(|(e, _)| e.episode.quantity).sum();
    let sold_quantity: i64 = episodes
        .iter()
        .flat_map(|e| e.of_kind(OutcomeKind::Sale))
        .map(|o| o.quantity)
        .sum();
    let removed_quantity: i64 = episodes
        .iter()
        .flat_map(|e| e.of_kind(OutcomeKind::Removed))
        .map(|o| o.quantity)
        .sum();
    let known_remaining: Vec<(&Prepared, f64, i64)> = known
        .iter()
        .map(|(e, listed)| (*e, *listed, e.episode.quantity - e.used()))
        .filter(|(_, _, quantity)| *quantity > 0)
        .collect();
    let uncertain = |e: &Prepared| uncertain_skus.contains(&e.episode.sku);
    let remaining_with_uncertain_presence_quantity: i64 = known_remaining
        .iter()
        .filter(|(e, ..)| uncertain(e))
        .map(|(.., q)| q)
        .sum();
    let remaining_with_known_age_quantity: i64 = known_remaining
        .iter()
        .filter(|(e, ..)| !uncertain(e))
        .map(|(.., q)| q)
        .sum();
    let sold_days: Vec<(f64, i64)> = known
        .iter()
        .flat_map(|(e, listed)| {
            e.of_kind(OutcomeKind::Sale)
                .map(move |o| (days_between(*listed, time(&o.happened_at)), o.quantity))
        })
        .collect();
    let sold_with_known_listed_date_quantity: i64 = sold_days.iter().map(|(_, q)| q).sum();
    let sold_only_average_days = (sold_with_known_listed_date_quantity != 0).then(|| {
        sold_days
            .iter()
            .fold(0.0, |sum, (days, q)| sum + days * *q as f64)
            / sold_with_known_listed_date_quantity as f64
    });
    let competing_removals = removed_quantity > 0 || has_unresolved_removal;
    let unsettled_outcomes = known
        .iter()
        .any(|(e, _)| unsettled_skus.contains(&e.episode.sku));
    let uncertain_presence = known_remaining.iter().any(|(e, ..)| uncertain(e));
    let percentile_unavailable = competing_removals || unsettled_outcomes || uncertain_presence;
    let (median_days_to_sale, p90_days_to_sale) = if percentile_unavailable {
        (None, None)
    } else {
        let observations = || -> Vec<Observation> {
            sold_days
                .iter()
                .map(|&(days, quantity)| Observation {
                    days,
                    quantity,
                    sold: true,
                })
                .chain(
                    known_remaining
                        .iter()
                        .map(|&(_, listed, quantity)| Observation {
                            days: days_between(listed, as_of),
                            quantity,
                            sold: false,
                        }),
                )
                .collect()
        };
        (
            reached_percentile(&mut observations(), 0.5),
            reached_percentile(&mut observations(), 0.1),
        )
    };

    Summary {
        cohort_quantity,
        known_listed_date_quantity,
        unknown_listed_date_quantity: cohort_quantity - known_listed_date_quantity,
        sold_quantity,
        sold_with_known_listed_date_quantity,
        remaining_with_known_age_quantity,
        remaining_with_uncertain_presence_quantity,
        removed_quantity,
        sold_only_average_days,
        median_days_to_sale,
        p90_days_to_sale,
        percentile_status: if unsettled_outcomes {
            PercentileStatus::UnsettledOutcomes
        } else if uncertain_presence {
            PercentileStatus::UncertainPresence
        } else if competing_removals {
            PercentileStatus::CompetingRemovals
        } else if median_days_to_sale.is_some() || p90_days_to_sale.is_some() {
            PercentileStatus::Estimable
        } else {
            PercentileStatus::NotReached
        },
        sell_through: SELL_THROUGH_HORIZONS
            .iter()
            .map(|&days| {
                let horizon = days as f64;
                let eligible: Vec<&(&Prepared, f64)> = known
                    .iter()
                    .filter(|(_, listed)| days_between(*listed, as_of) >= horizon)
                    .collect();
                let eligible_quantity: i64 = eligible.iter().map(|(e, _)| e.episode.quantity).sum();
                let sold_quantity: i64 = eligible
                    .iter()
                    .flat_map(|(e, listed)| {
                        e.of_kind(OutcomeKind::Sale)
                            .filter(move |o| days_between(*listed, time(&o.happened_at)) <= horizon)
                    })
                    .map(|o| o.quantity)
                    .sum();
                let unsettled = eligible
                    .iter()
                    .any(|(e, _)| unsettled_skus.contains(&e.episode.sku));
                SellThrough {
                    days,
                    eligible_quantity,
                    sold_quantity,
                    rate: (eligible_quantity != 0 && !unsettled)
                        .then(|| sold_quantity as f64 / eligible_quantity as f64),
                    status: if unsettled {
                        SellThroughStatus::UnsettledOutcomes
                    } else {
                        SellThroughStatus::Exact
                    },
                }
            })
            .collect(),
    }
}

fn detail(prepared: &Prepared, as_of: f64, uncertain_skus: &HashSet<i64>) -> EpisodeDetail {
    let episode = prepared.episode;
    let ledger_remaining_quantity = episode.quantity - prepared.used();
    EpisodeDetail {
        episode_key: episode.episode_key.clone(),
        receipt_id: episode.receipt_id,
        sku: episode.sku,
        product_line: episode.product_line.clone(),
        product_name: episode.product_name.clone(),
        kind: episode.kind,
        quantity: episode.quantity,
        listed_at: episode.listed_at.clone(),
        sold_quantity: prepared
            .of_kind(OutcomeKind::Sale)
            .map(|o| o.quantity)
            .sum(),
        removed_quantity: prepared
            .of_kind(OutcomeKind::Removed)
            .map(|o| o.quantity)
            .sum(),
        ledger_remaining_quantity,
        remaining_age_days: prepared
            .listed_time
            .filter(|_| ledger_remaining_quantity > 0)
            .map(|listed| days_between(listed, as_of)),
        presence_uncertain: uncertain_skus.contains(&episode.sku),
        forecast_evidence_provenance: episode.forecast_evidence_provenance,
        forecast_evidence: episode.forecast_evidence.clone(),
        orders: prepared
            .of_kind(OutcomeKind::Sale)
            .filter_map(|o| {
                Some(OrderSold {
                    order_number: o.order_number.clone().filter(|n| !n.is_empty())?,
                    quantity: o.quantity,
                    sold_at: o.happened_at.clone(),
                    listed_days: prepared
                        .listed_time
                        .map(|listed| days_between(listed, time(&o.happened_at))),
                })
            })
            .collect(),
    }
}

/// The report for one page of episode details, or why it cannot be built: the orders are not
/// fully known, or the history is larger than one read may hold.
pub fn build(evidence: &SourceEvidence, detail_page: usize) -> Result<Report, String> {
    let unavailable = |reason| {
        Ok(Report::Unavailable(Box::new(Unavailable {
            seller_key: evidence.seller_key.clone(),
            scope: evidence.scope.clone(),
            available_product_lines: evidence.available_product_lines.clone(),
            reason,
            order_coverage: evidence.order_coverage.clone(),
        })))
    };
    let coverage = &evidence.order_coverage;
    if coverage.seller_key != evidence.seller_key {
        return unavailable(UnavailableReason::SellerNotConfigured);
    }
    let Some(completed_at) = coverage
        .completed_at
        .as_deref()
        .filter(|at| coverage.status == "complete" && coverage.gaps.is_empty() && !at.is_empty())
    else {
        return unavailable(UnavailableReason::OrderCoverageIncomplete);
    };
    if evidence.episode_count > evidence.episodes.len() as i64
        || evidence.outcome_count > evidence.outcomes.len() as i64
    {
        return unavailable(UnavailableReason::HistoryBoundsExceeded);
    }

    let as_of = time(completed_at);
    let prepared = prepare(&evidence.episodes, &evidence.outcomes, as_of)?;
    let observed_at = evidence.inventory_observed_at.as_deref().map(time);
    let mut uncertain_skus: HashSet<i64> = evidence
        .projection
        .affected_skus
        .iter()
        .chain(&evidence.unresolved_removal.affected_skus)
        .copied()
        .collect();
    if observed_at.is_none_or(|at| at < as_of) {
        uncertain_skus.extend(prepared.iter().map(|p| p.episode.sku));
    }
    let mut grouped: Vec<(&str, Vec<&Prepared>)> = Vec::new();
    for episode in &prepared {
        match grouped
            .iter_mut()
            .find(|(line, _)| *line == episode.episode.product_line)
        {
            Some((_, rows)) => rows.push(episode),
            None => grouped.push((&episode.episode.product_line, vec![episode])),
        }
    }
    let mut product_lines: Vec<ProductLine> = grouped
        .iter()
        .map(|(line, rows)| {
            let unsettled: HashSet<i64> = rows
                .iter()
                .map(|r| r.episode.sku)
                .filter(|sku| evidence.projection.affected_skus.contains(sku))
                .collect();
            let unresolved = evidence
                .unresolved_removal
                .affected_skus
                .iter()
                .any(|sku| rows.iter().any(|r| r.episode.sku == *sku));
            ProductLine {
                product_line: line.to_string(),
                summary: summarize(rows, as_of, &uncertain_skus, &unsettled, unresolved),
            }
        })
        .collect();
    product_lines.sort_by_key(|l| std::cmp::Reverse(l.summary.cohort_quantity));
    let mut details: Vec<EpisodeDetail> = prepared
        .iter()
        .map(|p| detail(p, as_of, &uncertain_skus))
        .collect();
    details.sort_by(|l, r| match (&l.listed_at, &r.listed_at) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Greater,
        (_, None) => std::cmp::Ordering::Less,
        (Some(l), Some(r)) => collate::compare(r, l),
    });
    let detail_page_count = details.len().div_ceil(DETAIL_LIMIT).max(1);
    let selected_page = detail_page.clamp(1, detail_page_count);
    let detail_total = details.len();
    let page: Vec<EpisodeDetail> = details
        .into_iter()
        .skip((selected_page - 1) * DETAIL_LIMIT)
        .take(DETAIL_LIMIT)
        .collect();
    let all: Vec<&Prepared> = prepared.iter().collect();
    let overall_unsettled: HashSet<i64> =
        evidence.projection.affected_skus.iter().copied().collect();

    Ok(Report::Ready(Box::new(Ready {
        seller_key: evidence.seller_key.clone(),
        scope: evidence.scope.clone(),
        available_product_lines: evidence.available_product_lines.clone(),
        analysis_from: evidence.analysis_from.clone(),
        as_of: chrono::DateTime::from_timestamp_millis(as_of as i64)
            .map(iso)
            .unwrap_or_default(),
        order_coverage: coverage.clone(),
        overall: summarize(
            &all,
            as_of,
            &uncertain_skus,
            &overall_unsettled,
            evidence.unresolved_removal.quantity > 0,
        ),
        product_lines,
        details: page,
        detail_total,
        detail_page: selected_page,
        detail_page_count,
        coverage: Coverage {
            pending_projection_quantity: evidence.projection.pending_quantity,
            held_projection_quantity: evidence.projection.held_quantity,
            unresolved_removal_quantity: evidence.unresolved_removal.quantity,
            affected_removal_skus: evidence.unresolved_removal.affected_skus.len(),
            opening_unknown_quantity: evidence.opening_unknown_quantity,
            legacy_unlinked_quantity: evidence.legacy_unlinked.quantity,
            legacy_unlinked_forecast_quantity: evidence.legacy_unlinked.forecast_quantity,
            older_publication_quantity: evidence.older_publication_quantity,
            awaiting_cutoff_quantity: evidence.awaiting_cutoff_quantity,
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(index: i64) -> String {
        iso(chrono::DateTime::from_timestamp_millis(
            time("2026-01-01T00:00:00Z") as i64 + index * 86_400_000,
        )
        .unwrap())
    }

    fn evidence() -> SourceEvidence {
        SourceEvidence {
            seller_key: "seller".into(),
            scope: Scope::default(),
            available_product_lines: vec!["Magic".into(), "Pokemon".into()],
            analysis_from: day(-700),
            inventory_observed_at: Some(day(30)),
            order_coverage: OrderCoverage {
                status: "complete".into(),
                completed_at: Some(day(30)),
                orders_observed: 3,
                details_recorded: 3,
                ..OrderCoverage::not_started("seller")
            },
            episodes: Vec::new(),
            episode_count: 0,
            outcomes: Vec::new(),
            outcome_count: 0,
            projection: Projection::default(),
            opening_unknown_quantity: 7,
            legacy_unlinked: LegacyUnlinked::default(),
            older_publication_quantity: 0,
            awaiting_cutoff_quantity: 0,
            unresolved_removal: UnresolvedRemoval::default(),
        }
    }

    fn episode(receipt: i64, sku: i64, line: &str, quantity: i64, listed: i64) -> Episode {
        Episode {
            episode_key: format!("receipt:{receipt}"),
            receipt_id: receipt,
            sku,
            product_line: line.into(),
            product_name: "Card".into(),
            kind: EpisodeKind::ConfirmedPublication,
            quantity,
            listed_at: Some(day(listed)),
            forecast_evidence: None,
            forecast_evidence_provenance: ForecastProvenance::Unknown,
        }
    }

    fn episodes() -> Vec<Episode> {
        vec![
            episode(1, 101, "Pokemon", 3, 0),
            episode(2, 101, "Pokemon", 2, 4),
            episode(3, 202, "Magic", 10, 0),
            episode(4, 303, "Magic", 10, 25),
        ]
    }

    fn outcome(receipt: i64, kind: OutcomeKind, quantity: i64, at: i64, order: &str) -> Outcome {
        Outcome {
            episode_key: format!("receipt:{receipt}"),
            kind,
            quantity,
            happened_at: day(at),
            order_number: Some(order.into()),
            order_line_id: Some("1".into()),
            source: if kind == OutcomeKind::Sale {
                OutcomeSource::SellerOrder
            } else {
                OutcomeSource::Cancellation
            },
        }
    }

    fn with(episodes: Vec<Episode>, outcomes: Vec<Outcome>) -> SourceEvidence {
        SourceEvidence {
            episode_count: episodes.len() as i64,
            outcome_count: outcomes.len() as i64,
            episodes,
            outcomes,
            ..evidence()
        }
    }

    fn ready(evidence: &SourceEvidence) -> Ready {
        match build(evidence, 1).unwrap() {
            Report::Ready(ready) => *ready,
            other => panic!("expected a report, got {other:?}"),
        }
    }

    fn at_30(summary: &Summary) -> &SellThrough {
        summary.sell_through.iter().find(|s| s.days == 30).unwrap()
    }

    #[test]
    fn selling_history_keeps_cohorts_censoring_and_coverage() {
        let report = ready(&with(
            episodes(),
            vec![
                outcome(1, OutcomeKind::Sale, 3, 5, "A"),
                outcome(2, OutcomeKind::Sale, 1, 5, "A"),
                outcome(3, OutcomeKind::Sale, 2, 10, "B"),
            ],
        ));
        let line = |name: &str| {
            &report
                .product_lines
                .iter()
                .find(|l| l.product_line == name)
                .unwrap()
                .summary
        };
        let pokemon = line("Pokemon");
        assert_eq!(pokemon.sold_with_known_listed_date_quantity, 4);
        assert_eq!(pokemon.sold_only_average_days, Some(4.0));
        assert_eq!(pokemon.remaining_with_known_age_quantity, 1);
        assert_eq!(
            at_30(line("Magic")),
            &SellThrough {
                days: 30,
                eligible_quantity: 10,
                sold_quantity: 2,
                rate: Some(0.2),
                status: SellThroughStatus::Exact
            }
        );
        assert_eq!(
            (
                report.overall.median_days_to_sale,
                report.overall.p90_days_to_sale
            ),
            (None, None)
        );
        assert_eq!(report.coverage.opening_unknown_quantity, 7);

        let unsettled = ready(&SourceEvidence {
            projection: Projection {
                pending_quantity: 2,
                held_quantity: 0,
                affected_skus: vec![202],
            },
            ..with(vec![episodes()[2].clone()], Vec::new())
        });
        assert_eq!(unsettled.overall.median_days_to_sale, None);
        assert_eq!(
            unsettled.overall.percentile_status,
            PercentileStatus::UnsettledOutcomes
        );
        assert_eq!(
            at_30(&unsettled.overall),
            &SellThrough {
                days: 30,
                eligible_quantity: 10,
                sold_quantity: 0,
                rate: None,
                status: SellThroughStatus::UnsettledOutcomes
            }
        );

        let removed = ready(&with(
            vec![episodes()[2].clone()],
            vec![outcome(3, OutcomeKind::Removed, 1, 15, "C")],
        ));
        assert_eq!(
            removed.overall.percentile_status,
            PercentileStatus::CompetingRemovals
        );
        assert_eq!(removed.overall.median_days_to_sale, None);
        assert_eq!(at_30(&removed.overall).eligible_quantity, 10);

        let majority_sold = vec![outcome(3, OutcomeKind::Sale, 6, 10, "D")];
        let observed = ready(&with(vec![episodes()[2].clone()], majority_sold.clone()));
        assert_eq!(observed.overall.median_days_to_sale, Some(10.0));
        assert_eq!(
            observed.overall.percentile_status,
            PercentileStatus::Estimable
        );
        let stale = ready(&SourceEvidence {
            inventory_observed_at: Some(day(5)),
            ..with(vec![episodes()[2].clone()], majority_sold)
        });
        assert_eq!(stale.overall.median_days_to_sale, None);
        assert_eq!(
            stale.overall.percentile_status,
            PercentileStatus::UncertainPresence
        );

        let future = ready(&SourceEvidence {
            awaiting_cutoff_quantity: 10,
            ..with(
                vec![Episode {
                    listed_at: Some(day(31)),
                    ..episodes()[2].clone()
                }],
                Vec::new(),
            )
        });
        assert_eq!(future.overall.cohort_quantity, 0);
        assert_eq!(future.coverage.awaiting_cutoff_quantity, 10);

        let over_bound = build(
            &SourceEvidence {
                scope: Scope {
                    window_days: 730,
                    product_line: None,
                },
                episode_count: 20_001,
                ..evidence()
            },
            1,
        )
        .unwrap();
        let Report::Unavailable(unavailable) = over_bound else {
            panic!("unavailable")
        };
        let Unavailable {
            reason,
            scope,
            available_product_lines,
            ..
        } = *unavailable;
        assert_eq!(reason, UnavailableReason::HistoryBoundsExceeded);
        assert_eq!(
            scope,
            Scope {
                window_days: 730,
                product_line: None
            }
        );
        assert_eq!(available_product_lines, ["Magic", "Pokemon"]);
        ready(&SourceEvidence {
            scope: Scope {
                window_days: 180,
                product_line: Some("Magic".into()),
            },
            ..evidence()
        });

        let restock = Episode {
            episode_key: "restock:1:receipt:1".into(),
            kind: EpisodeKind::PhysicalRestock,
            quantity: 1,
            listed_at: None,
            ..episodes()[1].clone()
        };
        let returned = ready(&with(
            vec![episodes()[0].clone(), restock],
            vec![outcome(1, OutcomeKind::Removed, 1, 5, "A")],
        ));
        assert_eq!(returned.overall.unknown_listed_date_quantity, 1);
        assert_eq!(
            returned.overall.percentile_status,
            PercentileStatus::CompetingRemovals
        );
        assert_eq!(returned.overall.median_days_to_sale, None);

        let incomplete = SourceEvidence {
            order_coverage: OrderCoverage {
                status: "incomplete".into(),
                ..evidence().order_coverage
            },
            ..evidence()
        };
        assert!(matches!(
            build(&incomplete, 1).unwrap(),
            Report::Unavailable(_)
        ));
        assert!(matches!(
            build(
                &SourceEvidence {
                    episode_count: 1,
                    ..evidence()
                },
                1
            )
            .unwrap(),
            Report::Unavailable(_)
        ));
    }

    #[test]
    fn an_episode_that_uses_more_than_its_cohort_is_refused() {
        let over = with(
            vec![episodes()[0].clone()],
            vec![outcome(1, OutcomeKind::Sale, 4, 5, "A")],
        );
        assert_eq!(
            build(&over, 1).unwrap_err(),
            "Selling history episode receipt:1 uses more units than its cohort."
        );
    }
}
