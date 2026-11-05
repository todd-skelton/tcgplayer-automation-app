//! Proceeds matched to the purchases they paid for, in time order: `allocateReinvestmentTurnaround`.
use std::{cmp::Ordering, collections::HashMap};

use chrono::{DateTime, NaiveDate};
use serde_json::json;

use super::*;
use crate::features::{
    inventory_economics::ledger::{
        assumptions::js_round,
        fingerprint::{sha256_hex, stable_json},
        money::allocate as split,
    },
    inventory_strategy::collate,
};

const DAY_MS: f64 = 86_400_000.0;

/// `Date.parse` for the forms the evidence uses: a timestamp, or a date at midnight UTC.
pub(crate) fn instant(value: &str, label: &str) -> Result<i64, String> {
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        return Ok(at.timestamp_millis());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|d| {
            d.and_hms_opt(0, 0, 0)
                .expect("midnight")
                .and_utc()
                .timestamp_millis()
        })
        .map_err(|_| format!("{label} must be a valid date or timestamp."))
}

fn date_start(value: &str) -> Result<String, String> {
    let valid = value.len() == 10 && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok();
    if !valid {
        return Err("Funding and purchase dates must use YYYY-MM-DD.".into());
    }
    Ok(format!("{value}T00:00:00.000Z"))
}

#[derive(Clone, Debug)]
struct Bucket {
    id: String,
    amount_cents: i64,
    sold_at: Option<String>,
    provenance: Provenance,
    source_identities: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pool {
    Proceeds,
    Outside,
}

#[derive(Default)]
struct CurrencyState {
    proceeds: Vec<Bucket>,
    outside: Vec<Bucket>,
    reserves: Vec<(Bucket, Pool)>,
    eligible_proceeds_cents: i64,
    negative_proceeds_cents: i64,
    negative_deficit_cents: i64,
    reserved_or_withdrawn_cents: i64,
    unsupported_funding_adjustment_cents: i64,
    outside_funding_used_cents: i64,
    outside_funding_supplied_cents: i64,
    outside_deficit_settlement_cents: i64,
    outside_reserved_or_withdrawn_cents: i64,
    unresolved_purchase_cost_cents: i64,
}

impl CurrencyState {
    /// What a deficit left by negative proceeds takes first; the rest is returned.
    fn settle_deficit(&mut self, amount: i64, pool: Pool) -> i64 {
        let settled = self.negative_deficit_cents.min(amount);
        self.negative_deficit_cents -= settled;
        if pool == Pool::Outside {
            self.outside_deficit_settlement_cents += settled;
        }
        amount - settled
    }
}

/// Takes up to `requested` from the front of `buckets`, oldest first.
fn consume(buckets: &mut Vec<Bucket>, requested: i64) -> Vec<(Bucket, i64)> {
    let mut taken = Vec::new();
    let mut remaining = requested;
    while remaining > 0 && !buckets.is_empty() {
        let amount = remaining.min(buckets[0].amount_cents);
        taken.push((buckets[0].clone(), amount));
        buckets[0].amount_cents -= amount;
        remaining -= amount;
        if buckets[0].amount_cents == 0 {
            buckets.remove(0);
        }
    }
    taken
}

fn total(taken: &[(Bucket, i64)]) -> i64 {
    taken.iter().map(|(_, a)| a).sum()
}

fn sort_proceeds(buckets: &mut [Bucket]) -> Result<(), String> {
    let mut keyed = Vec::with_capacity(buckets.len());
    for b in buckets.iter() {
        keyed.push(instant(b.sold_at.as_deref().unwrap_or(""), "Sale time")?);
    }
    let mut order: Vec<usize> = (0..buckets.len()).collect();
    order.sort_by(|&a, &b| {
        keyed[a]
            .cmp(&keyed[b])
            .then_with(|| collate::compare(&buckets[a].id, &buckets[b].id))
    });
    let sorted: Vec<Bucket> = order.into_iter().map(|i| buckets[i].clone()).collect();
    buckets.clone_from_slice(&sorted);
    Ok(())
}

#[derive(Clone, Debug)]
struct Demand {
    tranche: Tranche,
    funding_at: String,
    timing_basis: TimingBasis,
    amount_cents: i64,
    funding_provenance: FundingProvenance,
    funding_adjustment_reference: Option<String>,
    funding_source_identity: Option<String>,
}

fn split_tranches(purchase: &Purchase) -> Result<Vec<Tranche>, String> {
    let sum: i64 = purchase.tranches.iter().map(|t| t.amount_cents).sum();
    if sum != purchase.total_amount_cents {
        return Err(format!(
            "Purchase {} tranches must equal its cost.",
            purchase.purchase_reference
        ));
    }
    let mut keyed = Vec::new();
    for t in &purchase.tranches {
        let at = match &t.published_at {
            Some(at) => instant(at, "Publication time")?,
            None => 9_007_199_254_740_991,
        };
        keyed.push((at, t.clone()));
    }
    keyed.sort_by(|(a, l), (b, r)| {
        a.cmp(b)
            .then(l.receipt_id.cmp(&r.receipt_id))
            .then_with(|| {
                collate::compare(
                    l.publication_item_id.as_deref().unwrap_or(""),
                    r.publication_item_id.as_deref().unwrap_or(""),
                )
            })
    });
    Ok(keyed.into_iter().map(|(_, t)| t).collect())
}

fn sorted_funding(purchase: &Purchase) -> Vec<PurchaseFunding> {
    let mut funding = purchase.funding.clone();
    funding.sort_by(|l, r| {
        collate::compare(&l.effective_at, &r.effective_at)
            .then_with(|| collate::compare(&l.adjustment_reference, &r.adjustment_reference))
    });
    funding
}

/// Funding recorded for a purchase beyond what it now costs.
pub fn unsupported_funding_for(purchase: &Purchase) -> Vec<UnsupportedFunding> {
    let mut remaining = purchase.total_amount_cents;
    sorted_funding(purchase)
        .into_iter()
        .filter_map(|f| {
            let supported = f.amount_cents.min(remaining);
            remaining -= supported;
            let amount = f.amount_cents - supported;
            (amount > 0).then(|| UnsupportedFunding {
                kind: UnsupportedKind::AboveCurrentCost,
                adjustment_reference: f.adjustment_reference,
                purchase_reference: Some(purchase.purchase_reference.clone()),
                currency: purchase.currency.clone(),
                amount_cents: amount,
                effective_at: f.effective_at,
                source_identity: f.source_identity,
            })
        })
        .collect()
}

fn demand(
    tranche: &Tranche,
    funding_at: String,
    basis: TimingBasis,
    cents: i64,
    provenance: FundingProvenance,
) -> Demand {
    Demand {
        tranche: tranche.clone(),
        funding_at,
        timing_basis: basis,
        amount_cents: cents,
        funding_provenance: provenance,
        funding_adjustment_reference: None,
        funding_source_identity: None,
    }
}

fn funded(tranche: &Tranche, f: &PurchaseFunding, cents: i64) -> Result<Demand, String> {
    Ok(Demand {
        funding_adjustment_reference: Some(f.adjustment_reference.clone()),
        funding_source_identity: Some(f.source_identity.clone()),
        ..demand(
            tranche,
            date_start(&f.effective_at)?,
            TimingBasis::KnownFunding,
            cents,
            f.provenance.into(),
        )
    })
}

/// When and how each part of a purchase was paid for.
fn demands_for(purchase: &Purchase, as_of: &str) -> Result<Vec<Demand>, String> {
    let tranches = split_tranches(purchase)?;
    let known = sorted_funding(purchase);
    let inferred = |t: &Tranche, cents: i64| {
        demand(
            t,
            t.published_at.clone().unwrap_or_else(|| as_of.to_owned()),
            TimingBasis::SaleToPublicationInference,
            cents,
            FundingProvenance::Inferred,
        )
    };
    if purchase.total_amount_cents == 0 {
        if let Some(f) = known.first() {
            return tranches.iter().map(|t| funded(t, f, 0)).collect();
        }
        if let Some(at) = &purchase.purchased_at {
            let at = date_start(at)?;
            return Ok(tranches
                .iter()
                .map(|t| {
                    demand(
                        t,
                        at.clone(),
                        TimingBasis::KnownPurchase,
                        0,
                        purchase.cost_provenance.into(),
                    )
                })
                .collect());
        }
        return Ok(tranches.iter().map(|t| inferred(t, 0)).collect());
    }
    if !known.is_empty() {
        let mut remaining_cost = purchase.total_amount_cents;
        let mut remaining: Vec<i64> = tranches.iter().map(|t| t.amount_cents).collect();
        let mut out = Vec::new();
        for f in &known {
            let funded_cents = f.amount_cents.min(remaining_cost);
            if funded_cents <= 0 {
                continue;
            }
            let ids: Vec<String> = (0..remaining.len()).map(|i| i.to_string()).collect();
            let targets: Vec<(&str, u64)> = ids
                .iter()
                .zip(&remaining)
                .map(|(id, c)| (id.as_str(), (*c).max(0) as u64))
                .collect();
            let shares = split(funded_cents, &targets)
                .ok_or("Allocation weights must include a positive value.")?;
            for share in shares {
                if share.cents == 0 {
                    continue;
                }
                let index: usize = share.id.parse().expect("an index");
                out.push(funded(&tranches[index], f, share.cents)?);
                remaining[index] -= share.cents;
            }
            remaining_cost -= funded_cents;
        }
        return Ok(out);
    }
    if let Some(at) = &purchase.purchased_at {
        let at = date_start(at)?;
        return Ok(tranches
            .iter()
            .map(|t| {
                demand(
                    t,
                    at.clone(),
                    TimingBasis::KnownPurchase,
                    t.amount_cents,
                    purchase.cost_provenance.into(),
                )
            })
            .collect());
    }
    Ok(tranches
        .iter()
        .map(|t| inferred(t, t.amount_cents))
        .collect())
}

fn weighted_days(samples: &[&Sample], field: fn(&Sample) -> Option<f64>) -> Option<f64> {
    let values: Vec<(f64, i64)> = samples
        .iter()
        .filter_map(|s| field(s).map(|d| (d, s.amount_cents)))
        .collect();
    let cents: i64 = values.iter().map(|(_, c)| c).sum();
    if cents == 0 {
        return None;
    }
    let micro: i128 = values
        .iter()
        .map(|(d, c)| i128::from(js_round(d * 1_000_000.0)) * i128::from(*c))
        .sum::<i128>()
        / i128::from(cents);
    Some(micro as f64 / 1_000_000.0)
}

fn weighted_percentile(samples: &[&Sample], percentile: i128) -> Option<f64> {
    let mut values: Vec<&&Sample> = samples
        .iter()
        .filter(|s| s.turnaround_days.is_some())
        .collect();
    values.sort_by(|l, r| {
        l.turnaround_days
            .partial_cmp(&r.turnaround_days)
            .unwrap_or(Ordering::Equal)
            .then_with(|| collate::compare(&l.sample_key, &r.sample_key))
    });
    let total: i128 = values.iter().map(|s| i128::from(s.amount_cents)).sum();
    if total == 0 {
        return None;
    }
    let target = (total * percentile + 99) / 100;
    let mut cumulative = 0;
    for s in &values {
        cumulative += i128::from(s.amount_cents);
        if cumulative >= target {
            return s.turnaround_days;
        }
    }
    values.last().and_then(|s| s.turnaround_days)
}

fn age_days(as_of: i64, at: i64) -> f64 {
    ((as_of - at) as f64 / DAY_MS).max(0.0)
}

fn max_of(values: impl Iterator<Item = f64>) -> Option<f64> {
    values.fold(None, |m, v| Some(m.map_or(v, |m: f64| m.max(v))))
}

fn summary(
    currency: &str,
    state: &CurrencyState,
    samples: &[Sample],
    as_of: i64,
) -> Result<CurrencySummary, String> {
    let relevant: Vec<&Sample> = samples.iter().filter(|s| s.currency == currency).collect();
    let completed: Vec<&Sample> = relevant
        .iter()
        .copied()
        .filter(|s| s.state == AllocationState::Completed)
        .collect();
    let waiting: Vec<&Sample> = relevant
        .iter()
        .copied()
        .filter(|s| s.state == AllocationState::Waiting)
        .collect();
    let completed_cents: i64 = completed.iter().map(|s| s.amount_cents).sum();
    let waiting_cents: i64 = waiting.iter().map(|s| s.amount_cents).sum();
    let reinvested = completed_cents + waiting_cents;
    let available: i64 = state.proceeds.iter().map(|b| b.amount_cents).sum();
    let mut ages = Vec::new();
    for b in &state.proceeds {
        ages.push((
            b.amount_cents,
            age_days(
                as_of,
                instant(b.sold_at.as_deref().unwrap_or(""), "Sale time")?,
            ),
        ));
    }
    let percent = |part: i64, whole: i64| (whole != 0).then(|| part as f64 / whole as f64 * 100.0);
    Ok(CurrencySummary {
        currency: currency.to_owned(),
        eligible_proceeds_cents: state.eligible_proceeds_cents,
        negative_proceeds_cents: state.negative_proceeds_cents,
        completed_cents,
        waiting_cents,
        unallocated_proceeds_cents: available,
        reserved_or_withdrawn_cents: state.reserved_or_withdrawn_cents,
        unsupported_funding_adjustment_cents: state.unsupported_funding_adjustment_cents,
        outside_funding_used_cents: state.outside_funding_used_cents,
        outside_funding_supplied_cents: state.outside_funding_supplied_cents,
        outside_deficit_settlement_cents: state.outside_deficit_settlement_cents,
        outside_available_cents: state.outside.iter().map(|b| b.amount_cents).sum(),
        outside_reserved_or_withdrawn_cents: state.outside_reserved_or_withdrawn_cents,
        outstanding_negative_deficit_cents: state.negative_deficit_cents,
        unresolved_purchase_cost_cents: state.unresolved_purchase_cost_cents,
        reinvested_percent: percent(reinvested, state.eligible_proceeds_cents),
        completion_coverage_percent: percent(completed_cents, reinvested),
        completed_dollar_weighted_mean_days: weighted_days(&completed, |s| s.turnaround_days),
        completed_weighted_median_days: weighted_percentile(&completed, 50),
        completed_weighted_p90_days: weighted_percentile(&completed, 90),
        waiting_dollar_weighted_age_days: weighted_days(&waiting, |s| s.waiting_age_days),
        oldest_waiting_days: max_of(waiting.iter().map(|s| s.waiting_age_days.unwrap_or(0.0))),
        unallocated_dollar_weighted_age_days: (!ages.is_empty())
            .then(|| ages.iter().map(|(c, d)| *c as f64 * d).sum::<f64>() / available as f64),
        oldest_unallocated_days: max_of(ages.iter().map(|(_, d)| *d)),
    })
}

enum Run {
    Outside(usize),
    Release(usize),
    Remove(usize),
    Sale(usize),
    Purchase(usize, Vec<Demand>),
}

struct Event {
    at: i64,
    rank: u8,
    id: String,
    run: Run,
}

struct Allocator<'a> {
    input: &'a Input,
    as_of: i64,
    states: HashMap<String, CurrencyState>,
    samples: Vec<Sample>,
    by_key: HashMap<String, usize>,
}

impl Allocator<'_> {
    fn state(&mut self, currency: &str) -> &mut CurrencyState {
        self.states.entry(currency.to_owned()).or_default()
    }

    fn record(
        &mut self,
        purchase: &Purchase,
        d: &Demand,
        bucket: &Bucket,
        amount: i64,
    ) -> Result<(), String> {
        let sold_at = bucket.sold_at.clone().unwrap_or_default();
        let sold = instant(&sold_at, "Sale time")?;
        let published = match (&d.tranche.publication_state, &d.tranche.published_at) {
            (PublicationState::Confirmed, Some(at)) => Some(at.clone()),
            _ => None,
        };
        let published_ms = match &published {
            Some(at) => Some(instant(at, "Publication time")?),
            None => None,
        };
        let completed = published_ms.is_some_and(|p| p <= self.as_of && p >= sold);
        let end = if completed {
            published_ms.unwrap_or(self.as_of)
        } else {
            self.as_of
        };
        let elapsed = age_days(end, sold);
        let mut sources = bucket.source_identities.clone();
        sources.push(purchase.cost_source_identity.clone());
        sources.extend(d.tranche.publication_identity.clone());
        sources.extend(d.funding_source_identity.clone());
        // A plain `.sort()`: by UTF-16 code units, not by locale.
        sources.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let sample_key = sha256_hex(&stable_json(&json!({
            "rule": RULE_VERSION,
            "currency": purchase.currency,
            "sale": bucket.id,
            "purchase": purchase.purchase_reference,
            "receipt": d.tranche.receipt_id,
            "productLineId": d.tranche.product_line_id,
            "publication": d.tranche.publication_item_id,
            "fundingAt": d.funding_at,
            "publishedAt": published,
            "sources": sources,
        })));
        let explain = |cents: i64| {
            if completed {
                format!(
                    "{cents} cents of pooled {} proceeds were attributed to {} and its first confirmed supported publication.",
                    provenance_word(bucket.provenance),
                    purchase.purchase_reference
                )
            } else {
                format!(
                    "{cents} cents of pooled {} proceeds were attributed to {}; supported publication is still waiting.",
                    provenance_word(bucket.provenance),
                    purchase.purchase_reference
                )
            }
        };
        if let Some(&i) = self.by_key.get(&sample_key) {
            let prior = &mut self.samples[i];
            prior.amount_cents += amount;
            prior.explanation = explain(prior.amount_cents);
            return Ok(());
        }
        self.by_key.insert(sample_key.clone(), self.samples.len());
        self.samples.push(Sample {
            sample_key,
            currency: purchase.currency.clone(),
            order_number: bucket.id.clone(),
            purchase_reference: purchase.purchase_reference.clone(),
            receipt_id: d.tranche.receipt_id,
            product_line_id: d.tranche.product_line_id,
            amount_cents: amount,
            sold_at,
            funding_at: d.funding_at.clone(),
            published_at: if completed { published } else { None },
            state: if completed {
                AllocationState::Completed
            } else {
                AllocationState::Waiting
            },
            timing_basis: d.timing_basis,
            proceeds_provenance: bucket.provenance,
            cost_provenance: purchase.cost_provenance,
            funding_provenance: d.funding_provenance,
            funding_adjustment_reference: d.funding_adjustment_reference.clone(),
            turnaround_days: completed.then_some(elapsed),
            waiting_age_days: (!completed).then_some(elapsed),
            explanation: explain(amount),
            source_identities: sources,
        });
        Ok(())
    }

    fn run(&mut self, event: Run) -> Result<(), String> {
        let input = self.input;
        match event {
            Run::Outside(i) => {
                let a = &input.funding_adjustments[i];
                let state = self.state(&a.currency);
                state.outside_funding_supplied_cents += a.amount_cents;
                let amount = state.settle_deficit(a.amount_cents, Pool::Outside);
                if amount != 0 {
                    state.outside.push(Bucket {
                        id: a.adjustment_reference.clone(),
                        amount_cents: amount,
                        sold_at: None,
                        provenance: a.provenance,
                        source_identities: vec![a.source_identity.clone()],
                    });
                }
            }
            Run::Release(i) => {
                let a = &input.funding_adjustments[i];
                let state = self.state(&a.currency);
                let mut remaining = a.amount_cents;
                while remaining > 0 && !state.reserves.is_empty() {
                    let (held, pool) = state.reserves[0].clone();
                    let amount = remaining.min(held.amount_cents);
                    let released = state.settle_deficit(amount, pool);
                    if released != 0 {
                        let bucket = Bucket {
                            amount_cents: released,
                            ..held.clone()
                        };
                        match pool {
                            Pool::Proceeds => state.proceeds.push(bucket),
                            Pool::Outside => state.outside.push(bucket),
                        }
                    }
                    state.reserves[0].0.amount_cents -= amount;
                    remaining -= amount;
                    state.reserved_or_withdrawn_cents -= amount;
                    if pool == Pool::Outside {
                        state.outside_reserved_or_withdrawn_cents -= amount;
                    }
                    if state.reserves[0].0.amount_cents == 0 {
                        state.reserves.remove(0);
                    }
                }
                sort_proceeds(&mut state.proceeds)?;
                state.unsupported_funding_adjustment_cents += remaining;
            }
            Run::Remove(i) => {
                let a = &input.funding_adjustments[i];
                let state = self.state(&a.currency);
                let from_proceeds = consume(&mut state.proceeds, a.amount_cents);
                let proceeds_cents = total(&from_proceeds);
                let from_outside = consume(&mut state.outside, a.amount_cents - proceeds_cents);
                let outside_cents = total(&from_outside);
                state.reserved_or_withdrawn_cents += proceeds_cents + outside_cents;
                state.outside_reserved_or_withdrawn_cents += outside_cents;
                state.unsupported_funding_adjustment_cents +=
                    a.amount_cents - proceeds_cents - outside_cents;
                if a.adjustment_type == AdjustmentType::Reserve {
                    for (bucket, amount) in from_proceeds {
                        state.reserves.push((
                            Bucket {
                                amount_cents: amount,
                                ..bucket
                            },
                            Pool::Proceeds,
                        ));
                    }
                    for (bucket, amount) in from_outside {
                        state.reserves.push((
                            Bucket {
                                amount_cents: amount,
                                ..bucket
                            },
                            Pool::Outside,
                        ));
                    }
                }
            }
            Run::Sale(i) => {
                let sale = &input.sales[i];
                let state = self.state(&sale.currency);
                if sale.amount_cents > 0 {
                    state.eligible_proceeds_cents += sale.amount_cents;
                    let amount = state.settle_deficit(sale.amount_cents, Pool::Proceeds);
                    if amount != 0 {
                        state.proceeds.push(Bucket {
                            id: sale.order_number.clone(),
                            amount_cents: amount,
                            sold_at: Some(sale.sold_at.clone()),
                            provenance: sale.provenance,
                            source_identities: sale
                                .source_identities
                                .clone()
                                .unwrap_or_else(|| vec![sale.source_identity.clone()]),
                        });
                    }
                } else if sale.amount_cents < 0 {
                    let reduction = -sale.amount_cents;
                    state.negative_proceeds_cents += reduction;
                    let consumed = total(&consume(&mut state.proceeds, reduction));
                    let mut remaining = reduction - consumed;
                    while remaining > 0 && !state.reserves.is_empty() {
                        let pool = state.reserves[0].1;
                        let amount = remaining.min(state.reserves[0].0.amount_cents);
                        state.reserves[0].0.amount_cents -= amount;
                        remaining -= amount;
                        state.reserved_or_withdrawn_cents -= amount;
                        if pool == Pool::Outside {
                            state.outside_reserved_or_withdrawn_cents -= amount;
                            state.outside_deficit_settlement_cents += amount;
                        }
                        if state.reserves[0].0.amount_cents == 0 {
                            state.reserves.remove(0);
                        }
                    }
                    let outside = total(&consume(&mut state.outside, remaining));
                    state.outside_deficit_settlement_cents += outside;
                    state.negative_deficit_cents += remaining - outside;
                }
            }
            Run::Purchase(p, demands) => {
                let purchase = &input.purchases[p];
                let state = self.state(&purchase.currency);
                let demanded: i64 = demands.iter().map(|d| d.amount_cents).sum();
                let outside = total(&consume(&mut state.outside, demanded));
                state.outside_funding_used_cents += outside;
                let needed = demanded - outside;
                let attributed = consume(&mut state.proceeds, needed);
                let attributed_cents = total(&attributed);
                state.unresolved_purchase_cost_cents += needed - attributed_cents;
                let targets = if attributed_cents != 0 {
                    let ids: Vec<String> = (0..demands.len()).map(|i| i.to_string()).collect();
                    let weights: Vec<(&str, u64)> = ids
                        .iter()
                        .zip(&demands)
                        .map(|(id, d)| (id.as_str(), d.amount_cents.max(0) as u64))
                        .collect();
                    split(attributed_cents, &weights)
                        .ok_or("Allocation weights must include a positive value.")?
                } else {
                    Vec::new()
                };
                let mut index = 0;
                let mut bucket_remaining = attributed.first().map_or(0, |(_, a)| *a);
                for target in targets {
                    let d = &demands[target.id.parse::<usize>().expect("an index")];
                    let mut target_remaining = target.cents;
                    while target_remaining > 0 && index < attributed.len() {
                        let amount = target_remaining.min(bucket_remaining);
                        self.record(purchase, d, &attributed[index].0, amount)?;
                        target_remaining -= amount;
                        bucket_remaining -= amount;
                        if bucket_remaining == 0 {
                            index += 1;
                            bucket_remaining = attributed.get(index).map_or(0, |(_, a)| *a);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn provenance_word(p: Provenance) -> &'static str {
    match p {
        Provenance::Actual => "actual",
        Provenance::Estimated => "estimated",
    }
}

const CONVENTION: [&str; 5] = [
    "Financial pooled attribution is an estimate; it is separate from physical FIFO and does not prove bank cash availability.",
    "Outside and opening cash funds purchases before sale proceeds. A reserve retains its original source and sale age; only held reserve can be released. Reserves, withdrawals, and negative proceeds make sale proceeds unavailable first.",
    "Known date-only purchase or funding evidence occurs before timestamped sales on the same date; same-day sales are not treated as earlier funding.",
    "Missing purchase timing uses a labeled sale-to-publication inference. Current corrected source versions are rebuilt; recorded-at history is not treated as occurrence time.",
    "Percentage reinvested uses all positive eligible proceeds as its denominator, including proceeds later reserved, withdrawn, or offset by negative effects.",
];

/// The turnaround report for `input`, or why its evidence cannot be read.
pub fn allocate(input: &Input) -> Result<Report, String> {
    let as_of = instant(&input.as_of, "Report as-of time")?;
    let mut events: Vec<Event> = Vec::new();
    let mut future_count = 0i64;
    let mut future_cents = 0i64;
    let mut currencies_seen: Vec<String> = Vec::new();
    let mut touch = |c: &str| {
        if !currencies_seen.iter().any(|s| s == c) {
            currencies_seen.push(c.to_owned());
        }
    };

    for (i, a) in input.funding_adjustments.iter().enumerate() {
        if a.amount_cents < 0 {
            return Err(format!(
                "Funding adjustment {} must be nonnegative whole cents.",
                a.adjustment_reference
            ));
        }
        let at = instant(&date_start(&a.effective_at)?, "Funding adjustment date")?;
        if at > as_of {
            future_count += 1;
            future_cents += a.amount_cents;
            continue;
        }
        touch(&a.currency);
        let id = format!("adjustment:{}", a.adjustment_reference);
        let (rank, run) = match a.adjustment_type {
            AdjustmentType::OpeningCash | AdjustmentType::ExternalContribution => {
                (0, Run::Outside(i))
            }
            AdjustmentType::ReserveRelease => (0, Run::Release(i)),
            AdjustmentType::Withdrawal | AdjustmentType::Reserve => (1, Run::Remove(i)),
        };
        events.push(Event { at, rank, id, run });
    }
    for (i, sale) in input.sales.iter().enumerate() {
        let at = instant(&sale.sold_at, "Sale time")?;
        if at > as_of {
            future_count += 1;
            future_cents += sale.amount_cents.abs();
            continue;
        }
        touch(&sale.currency);
        events.push(Event {
            at,
            rank: 3,
            id: format!("sale:{}", sale.order_number),
            run: Run::Sale(i),
        });
    }
    let mut observed_purchases: Vec<usize> = Vec::new();
    let mut unresolved_up_front: Vec<(String, i64)> = Vec::new();
    for (p, purchase) in input.purchases.iter().enumerate() {
        if purchase.total_amount_cents < 0 {
            return Err(format!(
                "Purchase {} must be nonnegative whole cents.",
                purchase.purchase_reference
            ));
        }
        let mut eligible = Vec::new();
        for d in demands_for(purchase, &input.as_of)? {
            if instant(&d.funding_at, "Purchase funding time")? <= as_of {
                eligible.push(d);
            }
        }
        if eligible.is_empty() {
            future_count += 1;
            future_cents += purchase.total_amount_cents;
            continue;
        }
        observed_purchases.push(p);
        touch(&purchase.currency);
        let funded: i64 = eligible.iter().map(|d| d.amount_cents).sum();
        unresolved_up_front.push((
            purchase.currency.clone(),
            purchase.total_amount_cents - funded,
        ));
        let mut groups: Vec<(String, Vec<Demand>)> = Vec::new();
        for d in eligible {
            let key = [
                d.funding_at.as_str(),
                d.funding_adjustment_reference.as_deref().unwrap_or(""),
                d.funding_source_identity.as_deref().unwrap_or(""),
            ]
            .join("\u{0}");
            match groups.iter_mut().find(|(k, _)| *k == key) {
                Some((_, g)) => g.push(d),
                None => groups.push((key, vec![d])),
            }
        }
        for (_, demands) in groups {
            let first = &demands[0];
            events.push(Event {
                at: instant(&first.funding_at, "Event time")?,
                rank: 2,
                id: format!(
                    "purchase:{}:{}",
                    purchase.purchase_reference,
                    first
                        .funding_adjustment_reference
                        .as_deref()
                        .unwrap_or("cost")
                ),
                run: Run::Purchase(p, demands),
            });
        }
    }

    let mut allocator = Allocator {
        input,
        as_of,
        states: HashMap::new(),
        samples: Vec::new(),
        by_key: HashMap::new(),
    };
    for currency in &currencies_seen {
        allocator.state(currency);
    }
    for (currency, cents) in unresolved_up_front {
        allocator.state(&currency).unresolved_purchase_cost_cents += cents;
    }
    events.sort_by(|l, r| {
        l.at.cmp(&r.at)
            .then(l.rank.cmp(&r.rank))
            .then_with(|| collate::compare(&l.id, &r.id))
    });
    for event in events {
        allocator.run(event.run)?;
    }
    let Allocator {
        states,
        mut samples,
        ..
    } = allocator;
    samples.sort_by(|l, r| {
        collate::compare(&l.currency, &r.currency)
            .then_with(|| collate::compare(&l.sold_at, &r.sold_at))
            .then_with(|| collate::compare(&l.sample_key, &r.sample_key))
    });
    let input_json = serde_json::to_value(input).map_err(|e| e.to_string())?;
    let source_fingerprint = sha256_hex(&stable_json(
        &json!({ "ruleVersion": RULE_VERSION, "input": input_json }),
    ));

    let future_of = |values: &Option<Vec<Option<String>>>, label: &str| -> Result<i64, String> {
        let mut n = 0;
        for at in values.iter().flatten().flatten() {
            if instant(at, label)? > as_of {
                n += 1;
            }
        }
        Ok(n)
    };
    let future_unknown_proceeds = future_of(
        &input.unknown_proceeds_sold_at,
        "Unknown-proceeds sale time",
    )?;
    let unknown_proceeds = (input.unknown_proceeds_order_count - future_unknown_proceeds).max(0);
    let future_unknown_costs = future_of(
        &input.unknown_cost_occurred_at,
        "Unknown-cost receipt occurrence",
    )?;
    let unknown_costs = (input.unknown_cost_receipt_count - future_unknown_costs).max(0);
    let mut excluded = Vec::new();
    if unknown_proceeds != 0 {
        excluded.push(Excluded {
            reason: "Orders without complete reusable-proceeds evidence".into(),
            count: unknown_proceeds,
            amount_cents: None,
            currency: None,
        });
    }
    if unknown_costs != 0 {
        excluded.push(Excluded {
            reason: "Receipt lots without a current supported cost".into(),
            count: unknown_costs,
            amount_cents: None,
            currency: None,
        });
    }
    let future_total = future_count + future_unknown_proceeds + future_unknown_costs;
    if future_total != 0 {
        excluded.push(Excluded {
            reason: "Evidence with an occurrence after the effective as-of cutoff".into(),
            count: future_total,
            amount_cents: Some(future_cents),
            currency: None,
        });
    }
    let mut eligible_sales = 0;
    for sale in &input.sales {
        if instant(&sale.sold_at, "Sale time")? <= as_of {
            eligible_sales += 1;
        }
    }
    let mut receipts: Vec<i64> = observed_purchases
        .iter()
        .flat_map(|&p| input.purchases[p].tranches.iter().map(|t| t.receipt_id))
        .collect();
    receipts.sort_unstable();
    receipts.dedup();
    let mut names: Vec<&String> = states.keys().collect();
    names.sort_by(|a, b| collate::compare(a, b));
    let mut currencies = Vec::new();
    for name in names {
        currencies.push(summary(name, &states[name], &samples, as_of)?);
    }
    Ok(Report {
        seller_key: input.seller_key.clone(),
        as_of: input.as_of.clone(),
        rule_version: RULE_VERSION.into(),
        source_fingerprint,
        current_corrected_view: true,
        date_precision: "timestamp_sales_date_funding".into(),
        currencies,
        samples,
        unsupported_purchase_funding: input.unsupported_purchase_funding.clone(),
        excluded,
        coverage: Coverage {
            observed_order_count: eligible_sales + unknown_proceeds,
            eligible_order_count: eligible_sales,
            unknown_proceeds_order_count: unknown_proceeds,
            purchase_count: observed_purchases.len() as i64,
            costed_receipt_count: receipts.len() as i64,
            unknown_cost_receipt_count: unknown_costs,
            unknown_proceeds: input
                .unknown_proceeds_sold_at
                .iter()
                .flatten()
                .map(|s| SoldAt { sold_at: s.clone() })
                .collect(),
            unknown_costs: input.unknown_cost_receipts.clone().unwrap_or_default(),
        },
        order_coverage: input.order_coverage.clone().flatten(),
        convention: CONVENTION.map(str::to_owned).to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tranche(
        receipt: i64,
        cents: i64,
        quantity: i64,
        published: Option<&str>,
        identity: &str,
    ) -> Tranche {
        Tranche {
            receipt_id: receipt,
            product_line_id: 1,
            publication_item_id: None,
            amount_cents: cents,
            quantity,
            published_at: published.map(str::to_owned),
            publication_state: if published.is_some() {
                PublicationState::Confirmed
            } else {
                PublicationState::Waiting
            },
            publication_identity: Some(identity.into()),
        }
    }

    fn sale(order: &str, at: &str, cents: i64) -> SaleProceeds {
        SaleProceeds {
            order_number: order.into(),
            sold_at: at.into(),
            currency: "USD".into(),
            amount_cents: cents,
            provenance: Provenance::Actual,
            source_identity: "sale-source".into(),
            source_identities: None,
        }
    }

    fn adjustment(
        reference: &str,
        kind: AdjustmentType,
        cents: i64,
        at: &str,
    ) -> FundingAdjustment {
        FundingAdjustment {
            adjustment_reference: reference.into(),
            currency: "USD".into(),
            adjustment_type: kind,
            amount_cents: cents,
            effective_at: at.into(),
            provenance: Provenance::Actual,
            source_identity: format!("{reference}-source"),
        }
    }

    fn purchase() -> Purchase {
        Purchase {
            purchase_reference: "replacement".into(),
            currency: "USD".into(),
            total_amount_cents: 10_000,
            cost_provenance: Provenance::Actual,
            cost_source_identity: "cost-source".into(),
            purchased_at: None,
            funding: Vec::new(),
            tranches: vec![
                tranche(1, 6_000, 6, Some("2026-01-11T00:00:00.000Z"), "pub-1"),
                tranche(2, 4_000, 4, Some("2026-01-21T00:00:00.000Z"), "pub-2"),
            ],
        }
    }

    fn input() -> Input {
        Input {
            seller_key: "synthetic-turnaround".into(),
            as_of: "2026-01-21T00:00:00.000Z".into(),
            sales: vec![sale("sale-1", "2026-01-01T00:00:00.000Z", 10_000)],
            purchases: vec![purchase()],
            unsupported_purchase_funding: Vec::new(),
            funding_adjustments: Vec::new(),
            unknown_proceeds_order_count: 0,
            unknown_proceeds_sold_at: None,
            unknown_cost_receipt_count: 0,
            unknown_cost_occurred_at: None,
            unknown_cost_receipts: None,
            order_coverage: None,
            source_evidence_identities: Vec::new(),
        }
    }

    fn usd(report: &Report) -> &CurrencySummary {
        &report.currencies[0]
    }

    #[test]
    fn pooled_attribution_keeps_cents_timing_and_partial_publication() {
        let completed = allocate(&input()).unwrap();
        let c = usd(&completed);
        assert_eq!(c.completed_cents, 10_000);
        assert_eq!(c.completed_dollar_weighted_mean_days, Some(14.0));
        assert_eq!(c.completed_weighted_median_days, Some(10.0));
        assert_eq!(c.completed_weighted_p90_days, Some(20.0));

        let mut waiting = input();
        waiting.as_of = "2026-01-15T00:00:00.000Z".into();
        waiting.purchases[0].tranches[1].published_at = None;
        waiting.purchases[0].tranches[1].publication_state = PublicationState::Waiting;
        let w = allocate(&waiting).unwrap();
        assert_eq!(
            (usd(&w).completed_cents, usd(&w).waiting_cents),
            (6_000, 4_000)
        );
        assert_eq!(usd(&w).completed_dollar_weighted_mean_days, Some(10.0));
        assert_eq!(usd(&w).completion_coverage_percent, Some(60.0));

        let mut known = input();
        known.sales[0].sold_at = "2026-01-03T00:00:00.000Z".into();
        known.purchases[0].funding = vec![PurchaseFunding {
            adjustment_reference: "funded-early".into(),
            amount_cents: 10_000,
            effective_at: "2026-01-02".into(),
            provenance: Provenance::Actual,
            source_identity: "fund-source".into(),
        }];
        let k = allocate(&known).unwrap();
        assert_eq!(usd(&k).completed_cents, 0);
        assert_eq!(usd(&k).unresolved_purchase_cost_cents, 10_000);
        assert_eq!(usd(&k).unallocated_proceeds_cents, 10_000);

        let mut outside_first = input();
        outside_first.funding_adjustments = vec![adjustment(
            "outside",
            AdjustmentType::ExternalContribution,
            4_000,
            "2026-01-01",
        )];
        let o = allocate(&outside_first).unwrap();
        assert_eq!(usd(&o).outside_funding_used_cents, 4_000);
        assert_eq!(usd(&o).completed_cents, 6_000);
        assert_eq!(usd(&o).unallocated_proceeds_cents, 4_000);

        assert_eq!(
            allocate(&input()).unwrap(),
            completed,
            "a rebuild repeats exactly"
        );

        let mut cents = input();
        cents.sales = vec![
            sale("cent-1", "2026-01-01T00:00:00.000Z", 1),
            sale("cent-2", "2026-01-01T00:00:00.000Z", 1),
        ];
        cents.purchases[0].total_amount_cents = 2;
        for t in &mut cents.purchases[0].tranches {
            t.amount_cents = 1;
            t.quantity = 1;
        }
        let one = allocate(&cents).unwrap();
        assert_eq!(
            one.samples
                .iter()
                .map(|s| s.amount_cents)
                .collect::<Vec<_>>(),
            [1, 1]
        );
        assert_eq!(usd(&one).completed_dollar_weighted_mean_days, Some(15.0));

        let mut before = input();
        before.as_of = "2025-12-31T00:00:00.000Z".into();
        let b = allocate(&before).unwrap();
        assert_eq!(b.coverage.eligible_order_count, 0);
        assert!(b.currencies.is_empty());
    }

    #[test]
    fn outside_cash_reserves_and_deficits() {
        let mut opening = input();
        opening.sales.clear();
        opening.purchases.clear();
        opening.funding_adjustments = vec![adjustment(
            "opening",
            AdjustmentType::OpeningCash,
            10_000,
            "2026-01-01",
        )];
        let r = allocate(&opening).unwrap();
        assert_eq!(
            (
                usd(&r).outside_funding_supplied_cents,
                usd(&r).outside_available_cents
            ),
            (10_000, 10_000)
        );

        let mut deficit = input();
        deficit.sales[0].amount_cents = -10_000;
        deficit.purchases.clear();
        deficit.funding_adjustments = vec![adjustment(
            "outside",
            AdjustmentType::ExternalContribution,
            4_000,
            "2026-01-02",
        )];
        let d = allocate(&deficit).unwrap();
        assert_eq!(usd(&d).outside_deficit_settlement_cents, 4_000);
        assert_eq!(usd(&d).outstanding_negative_deficit_cents, 6_000);
        assert_eq!(usd(&d).outside_available_cents, 0);

        let mut outside_purchase = input();
        outside_purchase.sales[0].amount_cents = -4_000;
        outside_purchase.purchases[0].total_amount_cents = 3_000;
        outside_purchase.purchases[0].purchased_at = Some("2026-01-03".into());
        outside_purchase.purchases[0].tranches.truncate(1);
        outside_purchase.purchases[0].tranches[0].amount_cents = 3_000;
        outside_purchase.funding_adjustments = vec![adjustment(
            "outside",
            AdjustmentType::ExternalContribution,
            10_000,
            "2026-01-02",
        )];
        let p = allocate(&outside_purchase).unwrap();
        assert_eq!(usd(&p).outside_deficit_settlement_cents, 4_000);
        assert_eq!(usd(&p).outside_funding_used_cents, 3_000);
        assert_eq!(usd(&p).outside_available_cents, 3_000);

        let mut reserve = input();
        reserve.sales.clear();
        reserve.purchases.clear();
        reserve.funding_adjustments = vec![
            adjustment(
                "outside",
                AdjustmentType::ExternalContribution,
                10_000,
                "2026-01-01",
            ),
            adjustment("reserve", AdjustmentType::Reserve, 4_000, "2026-01-02"),
            adjustment(
                "release",
                AdjustmentType::ReserveRelease,
                2_000,
                "2026-01-03",
            ),
        ];
        let v = allocate(&reserve).unwrap();
        assert_eq!(usd(&v).outside_reserved_or_withdrawn_cents, 2_000);
        assert_eq!(usd(&v).outside_available_cents, 8_000);

        let mut zero = input();
        zero.sales.clear();
        zero.purchases[0].total_amount_cents = 0;
        zero.purchases[0].tranches.truncate(1);
        zero.purchases[0].tranches[0].amount_cents = 0;
        let z = allocate(&zero).unwrap();
        assert_eq!(
            (z.coverage.purchase_count, z.coverage.costed_receipt_count),
            (1, 1)
        );
        assert!(z.samples.is_empty());
        assert!(
            !z.excluded
                .iter()
                .any(|e| e.reason.contains("after the effective"))
        );
    }
}
