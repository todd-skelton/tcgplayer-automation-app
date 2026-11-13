//! The slab valuation (`slabValuation.ts`): a descriptive range of the direct sales, each
//! weighted by its age, and the seller's ask proposed from its middle, held at or above what
//! the seller's costs and floors allow. Every figure is computed with JavaScript's arithmetic and
//! written in the key order saved calculations use, so the saved calculation, and the hash a
//! recommendation is deduplicated by, match those already saved. `Math.pow` is the platform's
//! `pow` in V8, not fdlibm's, so a weight can differ in its last bit where the two C libraries do
//! (3 in 20,000 ages measured on Windows); such a calculation is saved again rather than matched.
use serde::{Deserialize, Serialize};

pub use super::recommendation::Seller;
use crate::features::inventory_strategy::collate;

/// A slab pricing policy (`ValuationPolicy`), written in the key order saved calculations use.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub currency: String,
    pub basis: String,
    pub minimum_comps: f64,
    pub minimum_effective_count: f64,
    pub half_life_days: f64,
    pub maximum_age_days: f64,
    pub rounding_increment: f64,
    pub review_change_fraction: f64,
    pub review_spread_ratio: f64,
}

impl Policy {
    /// `DEFAULT_SLAB_POLICY` with the comparable price basis chosen.
    pub fn with_basis(basis: &str) -> Policy {
        Policy {
            currency: "USD".to_owned(),
            basis: basis.to_owned(),
            minimum_comps: 3.0,
            minimum_effective_count: 2.5,
            half_life_days: 90.0,
            maximum_age_days: 365.0,
            rounding_increment: 0.01,
            review_change_fraction: 0.25,
            review_spread_ratio: 4.0,
        }
    }
}

/// A sale an event's price rests on.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompReference {
    pub revision_id: String,
    pub provider: String,
    pub provider_id: String,
    pub date: Option<String>,
}

/// One sale event's price, on its day (`DirectComp`).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DirectComp {
    pub key: String,
    pub date: String,
    pub amount: f64,
    pub currency: String,
    /// `single-sale` or `listing-average`.
    pub kind: String,
    pub references: Vec<CompReference>,
}

/// A comp in the range, with its age and the weight that age gives it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weighted {
    #[serde(flatten)]
    pub comp: DirectComp,
    pub age_days: f64,
    pub weight: f64,
}

/// How far the evidence can be relied on (`EvidenceQuality`), in the key order saved
/// calculations use.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub uncertain: usize,
    pub rejected: usize,
    pub event_warnings: Vec<String>,
    pub stale: bool,
    pub capped: bool,
    pub partial: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Flag {
    pub code: String,
    pub review: bool,
}

fn flag(code: &str, review: bool) -> Flag {
    Flag {
        code: code.to_owned(),
        review,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Range {
    pub low: f64,
    pub midpoint: f64,
    pub high: f64,
    pub meaning: &'static str,
    pub calibrated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Span {
    pub low: f64,
    pub high: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Excluded {
    pub key: String,
    pub reason: &'static str,
}

/// The market for the slab (`MarketEstimate`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub status: &'static str,
    pub model_version: &'static str,
    pub as_of: String,
    pub currency: String,
    pub basis: String,
    pub range: Option<Range>,
    pub observed_span: Option<Span>,
    pub count: usize,
    pub effective_count: f64,
    pub comps: Vec<Weighted>,
    pub excluded: Vec<Excluded>,
    pub quality: Quality,
    pub flags: Vec<Flag>,
}

/// The ask proposed to the seller (`SellerAsk`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub proposed_item_ask: Option<f64>,
    pub estimated_proceeds: Option<f64>,
    pub estimated_profit: Option<f64>,
    pub applied_floor: Option<f64>,
    pub flags: Vec<Flag>,
    pub requires_review: bool,
}

const POLICY: &str = "Provide a valid, bounded slab pricing policy.";
const SELLER: &str =
    "Provide seller costs and fees in the pricing currency; unknown values must be explicit nulls.";
const BASES: [&str; 2] = ["item-only", "item-plus-shipping"];
const DAY_MS: f64 = 86_400_000.0;

/// An amount accepted: none, or at least 0 and under a billion.
fn money(value: Option<f64>) -> bool {
    value.is_none_or(|v| v.is_finite() && (0.0..1e9).contains(&v))
}

/// `Math.round(value * 1e8) / 1e8`.
pub fn tidy(value: f64) -> f64 {
    let scaled = value * 1e8;
    // `Math.round`: the nearest whole number, a half up; `scaled - floor` is exact.
    let floor = scaled.floor();
    let rounded = if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded / 1e8
}

fn currency_code(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|b| b.is_ascii_uppercase())
}

/// `validateValuationPolicy`.
pub fn validate_policy(p: &Policy) -> Result<Policy, String> {
    let within = |v: f64, low: f64, high: f64| v.is_finite() && v >= low && v <= high;
    let valid = currency_code(&p.currency)
        && BASES.contains(&p.basis.as_str())
        && p.minimum_comps.fract() == 0.0
        && within(p.minimum_comps, 3.0, 100.0)
        && within(p.minimum_effective_count, 1.0, p.minimum_comps)
        && within(p.half_life_days, 1.0, 1095.0)
        && within(p.maximum_age_days, 1.0, 3660.0)
        && [0.01, 0.05, 0.1, 0.25, 0.5, 1.0].contains(&p.rounding_increment)
        && p.review_change_fraction.is_finite()
        && p.review_change_fraction > 0.0
        && p.review_change_fraction <= 1.0
        && within(p.review_spread_ratio, 2.0, 100.0);
    if valid {
        Ok(p.clone())
    } else {
        Err(POLICY.to_owned())
    }
}

/// `validateSellerPriceContext`.
pub fn validate_seller(s: &Seller, currency: &str) -> Result<Seller, String> {
    let fees_ok = s.fees.as_ref().is_none_or(|f| {
        f.rate.is_finite()
            && (0.0..1.0).contains(&f.rate)
            && money(Some(f.fixed))
            && BASES.contains(&f.basis.as_str())
    });
    let amounts = [
        s.current_ask,
        s.shipping_charged,
        s.shipping_cost,
        s.acquisition_cost,
        s.minimum_ask,
        s.minimum_profit,
    ];
    if s.currency != currency || !amounts.into_iter().all(money) || !fees_ok {
        return Err(SELLER.to_owned());
    }
    Ok(s.clone())
}

/// A day written `YYYY-MM-DD` that is a real one, as milliseconds since the epoch.
fn day_millis(date: &str) -> Option<f64> {
    let shaped = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .filter(|_| shaped)?;
    Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64)
}

/// `estimateSlabMarket`: the comps within the policy's age and currency, weighted by age, and
/// their weighted middle half when there are enough; with what to review.
pub fn estimate(
    input: &[DirectComp],
    quality: Quality,
    as_of: &str,
    policy: &Policy,
) -> Result<Market, String> {
    let policy = validate_policy(policy)?;
    let now = super::publication::millis(as_of).map(|m| m as f64);
    let Some(now) = now.filter(|_| input.len() <= 2000) else {
        return Err("Provide a calculation time and at most 2,000 comparable events.".to_owned());
    };
    let (mut excluded, mut comps) = (Vec::new(), Vec::new());
    let mut seen = std::collections::HashSet::new();
    for comp in input {
        if !seen.insert(comp.key.as_str()) {
            return Err("Deduplicate source events before calculating a range.".to_owned());
        }
        let age_days = day_millis(&comp.date).map_or(f64::NAN, |d| (now - d) / DAY_MS);
        let reason = if !age_days.is_finite() || age_days < 0.0 {
            Some("sale-date-unresolved")
        } else if age_days > policy.maximum_age_days {
            Some("sale-outside-age-policy")
        } else if comp.currency != policy.currency {
            Some("currency-mismatch")
        } else if !money(Some(comp.amount)) || comp.amount <= 0.0 {
            Some("invalid-comp-price")
        } else {
            None
        };
        if let Some(reason) = reason {
            excluded.push(Excluded {
                key: comp.key.clone(),
                reason,
            });
            continue;
        }
        comps.push(Weighted {
            comp: comp.clone(),
            age_days,
            weight: 2f64.powf(-age_days / policy.half_life_days),
        });
    }
    comps.sort_by(|a, b| {
        a.comp
            .amount
            .partial_cmp(&b.comp.amount)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| collate::compare(&a.comp.key, &b.comp.key))
    });
    let effective: f64 = comps.iter().fold(0.0, |sum, c| sum + c.weight);
    let mut flags = Vec::new();
    if quality.stale {
        flags.push(flag("stale-evidence", true));
    }
    if quality.capped {
        flags.push(flag("capped-source-history", false));
    }
    if quality.partial {
        flags.push(flag("partial-market-coverage", false));
    }
    if comps.iter().any(|c| c.comp.kind == "listing-average") {
        flags.push(flag("range-includes-grouped-means", true));
    }
    flags.extend(quality.event_warnings.iter().map(|code| flag(code, true)));
    let span = comps.first().zip(comps.last()).map(|(low, high)| Span {
        low: low.comp.amount,
        high: high.comp.amount,
    });
    if span
        .as_ref()
        .is_some_and(|s| s.high / s.low > policy.review_spread_ratio)
    {
        flags.push(flag("wide-observed-price-spread", true));
    }
    let few = (comps.len() as f64) < policy.minimum_comps;
    let enough = !few && effective >= policy.minimum_effective_count;
    if !enough {
        flags.push(flag(
            if few {
                "too-few-direct-comps"
            } else {
                "too-little-recent-evidence"
            },
            true,
        ));
    }
    let quantile = |fraction: f64| {
        let threshold = fraction * effective;
        let mut cumulative = 0.0;
        for comp in &comps {
            cumulative += comp.weight;
            if cumulative >= threshold {
                return comp.comp.amount;
            }
        }
        comps[comps.len() - 1].comp.amount
    };
    let range = enough.then(|| Range {
        low: quantile(0.25),
        midpoint: quantile(0.5),
        high: quantile(0.75),
        meaning: "descriptive-middle-half",
        calibrated: false,
    });
    let needs_review =
        flags.iter().any(|f| f.review) || (comps.is_empty() && quality.uncertain > 0);
    let status =
        if !enough && quality.uncertain == 0 && !quality.stale && quality.event_warnings.is_empty()
        {
            "insufficient-evidence"
        } else if needs_review {
            "needs-review"
        } else {
            "direct-evidence"
        };
    Ok(Market {
        status,
        model_version: "direct-sales-v1",
        as_of: as_of.to_owned(),
        currency: policy.currency.clone(),
        basis: policy.basis.clone(),
        range,
        observed_span: span,
        count: comps.len(),
        effective_count: tidy(effective),
        comps,
        excluded,
        quality,
        flags,
    })
}

/// `proposeSlabAsk`: the item ask at the middle of the market, less the shipping the seller
/// charges, raised to the seller's floor, rounded up to the policy's increment; with what to
/// review and what the seller would keep.
pub fn propose(market: &Market, seller: &Seller, policy: &Policy) -> Result<Ask, String> {
    validate_policy(policy)?;
    let s = validate_seller(seller, &policy.currency)?;
    if market.currency != policy.currency || market.basis != policy.basis {
        return Err("Use the market estimate's currency and price basis.".to_owned());
    }
    let with_shipping = market.basis == "item-plus-shipping";
    let mut ask = Ask {
        proposed_item_ask: None,
        estimated_proceeds: None,
        estimated_profit: None,
        applied_floor: None,
        flags: market.flags.clone(),
        requires_review: market.status != "direct-evidence",
    };
    let comparable = match (s.current_ask, s.shipping_charged) {
        (Some(current), charged) if !with_shipping || charged.is_some() => Some(
            current
                + if with_shipping {
                    charged.unwrap_or(0.0)
                } else {
                    0.0
                },
        ),
        _ => None,
    };
    let Some(range) = &market.range else {
        let above = comparable
            .zip(market.observed_span.as_ref())
            .is_some_and(|(c, span)| c > span.high * (1.0 + policy.review_change_fraction));
        if above {
            ask.flags
                .push(flag("current-ask-above-sparse-observed-sales", true));
        }
        return Ok(ask);
    };
    if with_shipping && s.shipping_charged.is_none() {
        ask.flags
            .push(flag("seller-shipping-charge-unresolved", true));
        ask.requires_review = true;
        return Ok(ask);
    }
    let mut item = range.midpoint
        - if with_shipping {
            s.shipping_charged.unwrap_or(0.0)
        } else {
            0.0
        };
    let Some(floor) = s.lowest_ask() else {
        ask.flags
            .push(flag("profit-floor-cannot-be-verified", true));
        ask.requires_review = true;
        return Ok(ask);
    };
    if floor > item {
        ask.flags
            .push(flag("seller-floor-raised-proposed-ask", false));
        ask.applied_floor = Some(floor);
        item = floor;
    }
    if item <= 0.0 || !money(Some(item)) {
        let code = if item <= 0.0 {
            "seller-shipping-exceeds-market-value"
        } else {
            "proposed-ask-out-of-range"
        };
        ask.flags.push(flag(code, true));
        ask.requires_review = true;
        return Ok(ask);
    }
    let item = tidy((item / policy.rounding_increment - 1e-9).ceil() * policy.rounding_increment);
    ask.proposed_item_ask = Some(item);
    if let Some(current) = s.current_ask
        && (current == 0.0 || (item - current).abs() / current > policy.review_change_fraction)
    {
        ask.flags.push(flag("large-change-from-current-ask", true));
    }
    match (s.shipping_charged, s.shipping_cost, &s.fees) {
        (Some(charged), Some(cost), Some(fees)) => {
            let base = item
                + if fees.basis == "item-plus-shipping" {
                    charged
                } else {
                    0.0
                };
            let proceeds = tidy(item + charged - base * fees.rate - fees.fixed - cost);
            ask.estimated_proceeds = Some(proceeds);
            ask.estimated_profit = s.acquisition_cost.map(|a| tidy(proceeds - a));
        }
        _ => ask
            .flags
            .push(flag("proceeds-unknown-without-shipping-and-fees", false)),
    }
    if s.acquisition_cost.is_none() {
        ask.flags
            .push(flag("profit-unknown-without-acquisition-cost", false));
    }
    ask.requires_review = ask.requires_review || ask.flags.iter().any(|f| f.review);
    Ok(ask)
}
