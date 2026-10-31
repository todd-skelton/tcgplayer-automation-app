//! What snapping did, per threshold (`snapOutcomes.ts`): whether snapped listings sold faster,
//! drew add-ons that carried orders over the threshold, or were bought up in bulk, beside listings
//! that kept their price just above it.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{OrderEvidence, SnapOutcome, evidence::SnapPublication};
use crate::features::inventory_economics::ledger::assumptions::{js_round, js_to_fixed};

/// Three or more of a group's units in one order counts as buying in bulk.
pub const BULK_ORDER_UNITS: usize = 3;
const DAY_MS: f64 = 86_400_000.0;

/// How units in one group sold and what the orders they sold in looked like; a mean or share is
/// missing when there was nothing to take it from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleGroup {
    pub units: usize,
    pub orders: usize,
    /// Mean units per order, counting every line in those orders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units_per_order: Option<f64>,
    /// Mean value of everything else bought alongside the group's units, per order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_items_value_per_order: Option<f64>,
    /// Share of orders with anything besides the group's units.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orders_with_add_ons: Option<f64>,
    /// For units priced under the threshold, the share of orders other items carried to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orders_reaching_threshold: Option<f64>,
    /// Most units of the group bought in one order.
    pub largest_order_units: usize,
    /// Share of units bought in orders holding three or more of the group's units.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bulk_order_unit_share: Option<f64>,
    /// Mean postage less buyer shipping after fees, over orders with postage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipping_cost_per_order: Option<f64>,
    /// Median days from the first publication of the decision to the sale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_days_to_sell: Option<f64>,
}

/// SKUs by the outcome of their latest considered decision in the window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Listings {
    pub snapped: usize,
    pub kept: usize,
    pub floor: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub threshold: f64,
    pub snap_price: f64,
    pub listings: Listings,
    /// Units sold at the snap price while snapped.
    pub snapped: SaleGroup,
    /// Units sold within the snap range after the snap was considered and kept.
    pub kept: SaleGroup,
    /// Every unit sold from the threshold to the top of the snap range, for comparison.
    pub just_above: SaleGroup,
}

/// Units of one order line sold, and the days since the decision they sold under was published.
struct Sold<'a> {
    order: &'a OrderEvidence,
    units: usize,
    unit_price: f64,
    days_to_sell: Option<f64>,
}

/// A run of consecutive considered publications of one SKU with the same outcome.
struct Run {
    first_published_at: DateTime<Utc>,
    outcome: SnapOutcome,
}

fn cents(value: f64) -> i64 {
    js_round(value * 100.0)
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// `Number(value.toFixed(places))`.
fn round(value: Option<f64>, places: usize) -> Option<f64> {
    value.map(|v| js_to_fixed(v, places).parse().unwrap_or(f64::NAN))
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    Some(if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    })
}

/// `summarizeSales`.
fn summarize(sold: &[Sold], threshold: f64, overhead_rate: f64) -> SaleGroup {
    let under_threshold = sold.iter().all(|s| cents(s.unit_price) < cents(threshold));
    // Each order once, first seen first, with the group's units and their value in it.
    let mut groups: Vec<(&OrderEvidence, usize, f64)> = Vec::new();
    for s in sold {
        match groups
            .iter_mut()
            .find(|(order, _, _)| order.order_number == s.order.order_number)
        {
            Some((_, units, value)) => {
                *units += s.units;
                *value += s.units as f64 * s.unit_price;
            }
            None => groups.push((s.order, s.units, s.units as f64 * s.unit_price)),
        }
    }
    let units: usize = groups.iter().map(|(_, units, _)| units).sum();
    let bulk_units: usize = groups
        .iter()
        .map(|(_, units, _)| *units)
        .filter(|units| *units >= BULK_ORDER_UNITS)
        .sum();
    let shipping: Vec<f64> = groups
        .iter()
        .filter_map(|(order, _, _)| {
            order.postage.map(|postage| {
                postage - order.buyer_shipping.unwrap_or(0.0) * (1.0 - overhead_rate)
            })
        })
        .collect();
    let per_order = |f: &dyn Fn(&OrderEvidence, f64) -> f64| -> Vec<f64> {
        groups
            .iter()
            .map(|(order, _, value)| f(order, *value))
            .collect()
    };
    SaleGroup {
        units,
        orders: groups.len(),
        units_per_order: round(
            mean(&per_order(&|order, _| {
                order.lines.iter().map(|l| l.quantity as f64).sum()
            })),
            2,
        ),
        other_items_value_per_order: round(
            mean(&per_order(&|order, value| {
                (order.item_value - value).max(0.0)
            })),
            2,
        ),
        orders_with_add_ons: round(
            mean(&per_order(&|order, value| {
                f64::from(u8::from(cents(order.item_value) > cents(value)))
            })),
            3,
        ),
        orders_reaching_threshold: if under_threshold {
            round(
                mean(&per_order(&|order, _| {
                    f64::from(u8::from(cents(order.item_value) >= cents(threshold)))
                })),
                3,
            )
        } else {
            None
        },
        largest_order_units: groups.iter().map(|(_, units, _)| *units).max().unwrap_or(0),
        bulk_order_unit_share: (units > 0)
            .then(|| bulk_units as f64 / units as f64)
            .and_then(|share| round(Some(share), 3)),
        shipping_cost_per_order: round(mean(&shipping), 2),
        median_days_to_sell: round(
            median(
                &sold
                    .iter()
                    .filter_map(|s| s.days_to_sell)
                    .collect::<Vec<_>>(),
            ),
            1,
        ),
    }
}

/// Each SKU's considered publications for one threshold, grouped into runs of one outcome.
fn decision_runs(publications: &[SnapPublication], threshold: f64) -> HashMap<i64, Vec<Run>> {
    let mut runs: HashMap<i64, Vec<Run>> = HashMap::new();
    for publication in publications
        .iter()
        .filter(|p| p.snap.threshold == threshold)
    {
        let sku_runs = runs.entry(publication.sku).or_default();
        match sku_runs.last_mut() {
            Some(current) if current.outcome == publication.snap.outcome => {}
            _ => sku_runs.push(Run {
                first_published_at: publication.published_at,
                outcome: publication.snap.outcome,
            }),
        }
    }
    runs
}

fn outcome(
    threshold: f64,
    snap_range: f64,
    overhead_rate: f64,
    orders: &[OrderEvidence],
    publications: &[SnapPublication],
) -> Outcome {
    let snap_price = (cents(threshold) - 1) as f64 / 100.0;
    let range_top = cents(threshold * (1.0 + snap_range));
    let runs = decision_runs(publications, threshold);
    let (mut snapped, mut kept, mut just_above) = (Vec::new(), Vec::new(), Vec::new());
    for order in orders {
        for line in &order.lines {
            let sold = |days_to_sell| Sold {
                order,
                units: line.quantity,
                unit_price: line.unit_price,
                days_to_sell,
            };
            let at = cents(line.unit_price);
            let in_range = at >= cents(threshold) && at <= range_top;
            if in_range {
                just_above.push(sold(None));
            }
            let run = runs.get(&line.sku).and_then(|runs| {
                runs.iter()
                    .rfind(|run| run.first_published_at <= order.order_time)
            });
            let Some(run) = run else {
                continue;
            };
            let days =
                (order.order_time - run.first_published_at).num_milliseconds() as f64 / DAY_MS;
            if run.outcome == SnapOutcome::Snapped && at == cents(snap_price) {
                snapped.push(sold(Some(days)));
            } else if run.outcome == SnapOutcome::Kept && in_range {
                kept.push(sold(Some(days)));
            }
        }
    }
    let mut listings = Listings::default();
    for sku_runs in runs.values() {
        match sku_runs.last().map(|run| run.outcome) {
            Some(SnapOutcome::Snapped) => listings.snapped += 1,
            Some(SnapOutcome::Kept) => listings.kept += 1,
            Some(SnapOutcome::Floor) => listings.floor += 1,
            None => {}
        }
    }
    Outcome {
        threshold,
        snap_price,
        listings,
        snapped: summarize(&snapped, threshold, overhead_rate),
        kept: summarize(&kept, threshold, overhead_rate),
        just_above: summarize(&just_above, threshold, overhead_rate),
    }
}

/// `shippingThresholdSnapOutcomes`: each threshold's outcome, lowest threshold first.
pub fn outcomes(
    thresholds: &[f64],
    snap_range: f64,
    overhead_rate: f64,
    orders: &[OrderEvidence],
    publications: &[SnapPublication],
) -> Vec<Outcome> {
    let mut sorted = thresholds.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted
        .into_iter()
        .map(|threshold| outcome(threshold, snap_range, overhead_rate, orders, publications))
        .collect()
}
