//! Each section's form as the browser sends it. A section saves on every change; a value that
//! does not read keeps what was stored and is named, and the rest of the section is saved.
use corten::prelude::*;
use serde::Deserialize;

use super::config::{
    DEFAULT_HORIZON_DAYS, EVIDENCE_WINDOWS, LineSetting, Policy, Pricing, ProfitPerDay,
    SHIPPING_THRESHOLDS, Snaps, Supply,
};

/// The policy select's words, as the React app stores them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    Percentile,
    TargetHorizon,
    ProfitPerDay,
}

/// Reads a number field: `Some` when it is a number `ok` accepts, otherwise its message is added
/// and the stored value stays.
fn number(
    errors: &mut Errors,
    field: FieldName<String>,
    text: &str,
    stored: f64,
    ok: impl Fn(f64) -> bool,
    rule: &str,
) -> f64 {
    match text.trim().parse::<f64>() {
        Ok(n) if n.is_finite() && ok(n) => n,
        _ => {
            errors.add(field, rule.to_owned());
            stored
        }
    }
}

fn percent(n: f64) -> bool {
    (0.0..=100.0).contains(&n)
}

#[derive(Clone, Debug, Deserialize, Fields)]
pub struct PricingInput {
    pub policy: Method,
    pub horizon_days: String,
    pub daily_return_hurdle: String,
    pub relative_overhead: String,
    pub static_overhead_per_unit: String,
    pub default_percentile: String,
    pub min_percentile: String,
    pub max_percentile: String,
    pub percentile_step: String,
    pub skip_prefix: String,
    pub min_price_multiplier: String,
    pub min_price_constant: String,
    pub success_rate_low: String,
    pub success_rate_high: String,
}

impl PricingInput {
    pub fn of(p: &Pricing) -> Self {
        let (policy, horizon) = match p.policy {
            Policy::Percentile => (Method::Percentile, DEFAULT_HORIZON_DAYS),
            Policy::TargetHorizon(days) => (Method::TargetHorizon, days),
            Policy::ProfitPerDay => (Method::ProfitPerDay, DEFAULT_HORIZON_DAYS),
        };
        PricingInput {
            policy,
            horizon_days: horizon.to_string(),
            daily_return_hurdle: p.profit_per_day.daily_return_hurdle.to_string(),
            relative_overhead: p.profit_per_day.relative_overhead.to_string(),
            static_overhead_per_unit: p.profit_per_day.static_overhead_per_unit.to_string(),
            default_percentile: p.default_percentile.to_string(),
            min_percentile: p.min_percentile.to_string(),
            max_percentile: p.max_percentile.to_string(),
            percentile_step: p.percentile_step.to_string(),
            skip_prefix: p.skip_prefix.clone(),
            min_price_multiplier: p.min_price_multiplier.to_string(),
            min_price_constant: p.min_price_constant.to_string(),
            success_rate_low: p.success_rate_low.to_string(),
            success_rate_high: p.success_rate_high.to_string(),
        }
    }

    /// The section to save, and what in it did not read.
    pub fn read(&self, stored: &Pricing) -> (Pricing, Errors) {
        let f = Self::FIELDS;
        let mut e = Errors::new();
        let horizon = match stored.policy {
            Policy::TargetHorizon(days) => days,
            _ => DEFAULT_HORIZON_DAYS,
        };
        let policy = match self.policy {
            Method::Percentile => Policy::Percentile,
            Method::ProfitPerDay => Policy::ProfitPerDay,
            Method::TargetHorizon => Policy::TargetHorizon(number(
                &mut e,
                f.horizon_days,
                &self.horizon_days,
                horizon,
                |n| n > 0.0,
                "Enter a number of days above 0.",
            )),
        };
        let s = &stored.profit_per_day;
        let profit_per_day = ProfitPerDay {
            daily_return_hurdle: number(
                &mut e,
                f.daily_return_hurdle,
                &self.daily_return_hurdle,
                s.daily_return_hurdle,
                ProfitPerDay::hurdle_is_valid,
                "Enter a fraction above 0 and below 1.",
            ),
            relative_overhead: number(
                &mut e,
                f.relative_overhead,
                &self.relative_overhead,
                s.relative_overhead,
                ProfitPerDay::overhead_is_valid,
                "Enter a fraction from 0 to below 1.",
            ),
            static_overhead_per_unit: number(
                &mut e,
                f.static_overhead_per_unit,
                &self.static_overhead_per_unit,
                s.static_overhead_per_unit,
                ProfitPerDay::static_overhead_is_valid,
                "Enter an amount of at least 0.",
            ),
        };
        const PERCENT: &str = "Enter a percentile from 0 to 100.";
        let pricing = Pricing {
            policy,
            profit_per_day,
            default_percentile: number(
                &mut e,
                f.default_percentile,
                &self.default_percentile,
                stored.default_percentile,
                percent,
                PERCENT,
            ),
            min_percentile: number(
                &mut e,
                f.min_percentile,
                &self.min_percentile,
                stored.min_percentile,
                percent,
                PERCENT,
            ),
            max_percentile: number(
                &mut e,
                f.max_percentile,
                &self.max_percentile,
                stored.max_percentile,
                percent,
                PERCENT,
            ),
            percentile_step: number(
                &mut e,
                f.percentile_step,
                &self.percentile_step,
                stored.percentile_step,
                |n| (1.0..=20.0).contains(&n),
                "Enter a step from 1 to 20.",
            ),
            skip_prefix: self.skip_prefix.clone(),
            min_price_multiplier: number(
                &mut e,
                f.min_price_multiplier,
                &self.min_price_multiplier,
                stored.min_price_multiplier,
                |n| (0.0..=2.0).contains(&n),
                "Enter a multiplier from 0 to 2.",
            ),
            min_price_constant: number(
                &mut e,
                f.min_price_constant,
                &self.min_price_constant,
                stored.min_price_constant,
                |n| (0.0..=1.0).contains(&n),
                "Enter an amount from 0 to 1.",
            ),
            success_rate_low: number(
                &mut e,
                f.success_rate_low,
                &self.success_rate_low,
                stored.success_rate_low,
                percent,
                "Enter a rate from 0 to 100.",
            ),
            success_rate_high: number(
                &mut e,
                f.success_rate_high,
                &self.success_rate_high,
                stored.success_rate_high,
                percent,
                "Enter a rate from 0 to 100.",
            ),
        };
        (pricing, e)
    }
}

#[derive(Clone, Debug, Deserialize, Fields)]
pub struct SnapsInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub thresholds: Vec<u32>,
    pub snap_range: String,
    pub evidence_window_days: u32,
}

impl SnapsInput {
    pub fn of(s: &Snaps) -> Self {
        SnapsInput {
            enabled: s.enabled,
            thresholds: s.thresholds.clone(),
            snap_range: s.snap_range.to_string(),
            evidence_window_days: s.evidence_window_days,
        }
    }

    pub fn read(&self, stored: &Snaps) -> (Snaps, Errors) {
        let f = Self::FIELDS;
        let mut e = Errors::new();
        let snap_range = number(
            &mut e,
            f.snap_range,
            &self.snap_range,
            stored.snap_range,
            Snaps::range_is_valid,
            "Enter a fraction above 0 and at most 0.5.",
        );
        let evidence_window_days = if EVIDENCE_WINDOWS.contains(&self.evidence_window_days) {
            self.evidence_window_days
        } else {
            e.add(f.evidence_window_days, "Choose one of the listed windows.");
            stored.evidence_window_days
        };
        let snaps = Snaps {
            enabled: self.enabled,
            thresholds: SHIPPING_THRESHOLDS
                .into_iter()
                .filter(|t| self.thresholds.contains(t))
                .collect(),
            snap_range,
            evidence_window_days,
        };
        (snaps, e)
    }
}

#[derive(Clone, Debug, Deserialize, Fields)]
pub struct SupplyInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub include_unverified_sellers: bool,
}

impl SupplyInput {
    pub fn of(supply: &Supply) -> Self {
        SupplyInput {
            enabled: supply.enabled,
            include_unverified_sellers: supply.include_unverified_sellers,
        }
    }

    pub fn read(&self) -> Supply {
        Supply {
            enabled: self.enabled,
            include_unverified_sellers: self.include_unverified_sellers,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct DefaultPercentileInput {
    pub default_percentile: String,
}

impl DefaultPercentileInput {
    pub fn read(&self, stored: f64) -> (f64, Errors) {
        let mut e = Errors::new();
        let f = Self::FIELDS;
        let n = number(
            &mut e,
            f.default_percentile,
            &self.default_percentile,
            stored,
            percent,
            "Enter a percentile from 0 to 100.",
        );
        (n, e)
    }
}

/// A product line to price differently, by its id; none when nothing was picked.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct AddLineInput {
    pub product_line: Option<i32>,
    #[serde(default)]
    pub percentile: String,
    #[serde(default)]
    pub daily_return_hurdle: String,
    #[serde(default)]
    pub skip: bool,
}

impl AddLineInput {
    /// The product line and its setting; `configurable` says whether an id is one the picker
    /// offered (a product line not configured yet).
    pub fn read(
        &self,
        default_percentile: f64,
        configurable: impl Fn(i32) -> bool,
    ) -> Result<(i32, LineSetting), Errors> {
        let f = Self::FIELDS;
        let mut e = Errors::new();
        let id = match self.product_line {
            Some(id) if configurable(id) => id,
            _ => {
                e.add(
                    f.product_line,
                    "Choose a product line that is not configured yet.",
                );
                0
            }
        };
        let setting = if self.skip {
            LineSetting {
                percentile: default_percentile,
                skip: true,
                daily_return_hurdle: None,
            }
        } else {
            let percentile = number(
                &mut e,
                f.percentile,
                &self.percentile,
                default_percentile,
                percent,
                "Enter a percentile from 0 to 100.",
            );
            let daily_return_hurdle = match self.daily_return_hurdle.trim() {
                "" => None,
                text => Some(number(
                    &mut e,
                    f.daily_return_hurdle,
                    text,
                    0.0,
                    ProfitPerDay::hurdle_is_valid,
                    "Enter a fraction above 0 and below 1, or leave it blank.",
                )),
            };
            LineSetting {
                percentile,
                skip: false,
                daily_return_hurdle,
            }
        };
        e.into_result((id, setting))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_of_the_pricing_reads_back_as_it() {
        let stored = Pricing {
            policy: Policy::TargetHorizon(12.5),
            ..Pricing::default()
        };
        let (read, errors) = PricingInput::of(&stored).read(&stored);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(read, stored);
    }

    #[test]
    fn a_value_that_does_not_read_keeps_the_stored_one_and_the_rest_save() {
        let stored = Pricing::default();
        let input = PricingInput {
            daily_return_hurdle: "2".into(),
            skip_prefix: "Z-".into(),
            ..PricingInput::of(&stored)
        };
        let (read, errors) = input.read(&stored);
        assert_eq!(read.profit_per_day.daily_return_hurdle, 0.005);
        assert_eq!(read.skip_prefix, "Z-");
        assert!(errors.has(PricingInput::FIELDS.daily_return_hurdle));
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn a_skipped_line_keeps_no_hurdle() {
        let input = AddLineInput {
            product_line: Some(3),
            daily_return_hurdle: "0.01".into(),
            skip: true,
            ..Default::default()
        };
        let (id, setting) = input.read(65.0, |_| true).unwrap();
        assert_eq!(
            (id, setting.skip, setting.daily_return_hurdle),
            (3, true, None)
        );
    }

    #[test]
    fn a_line_already_configured_is_refused() {
        let input = AddLineInput {
            product_line: Some(3),
            percentile: "70".into(),
            ..Default::default()
        };
        assert!(input.read(65.0, |id| id != 3).is_err());
    }
}
