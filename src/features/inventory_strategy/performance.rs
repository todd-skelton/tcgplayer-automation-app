//! What the seller's selling actually earned: margin, profit per day and return on the capital
//! tied up, over trailing windows and week by week, from each sold unit's share of its order's
//! net proceeds and its lot's cost. Ported from the Node app's `realizedPerformance.ts` and
//! `marginTrend.ts`.
use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use super::collate;

/// A trailing window the realized figures are shown for, written in an address as its days.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, corten::UrlValue)]
pub enum RealizedWindow {
    #[default]
    #[serde(rename = "30")]
    Days30,
    #[serde(rename = "90")]
    Days90,
}

impl RealizedWindow {
    pub const ALL: [RealizedWindow; 2] = [RealizedWindow::Days30, RealizedWindow::Days90];

    pub const fn days(self) -> i64 {
        match self {
            RealizedWindow::Days30 => 30,
            RealizedWindow::Days90 => 90,
        }
    }

    pub fn of(days: i64) -> Option<RealizedWindow> {
        RealizedWindow::ALL.into_iter().find(|w| w.days() == days)
    }
}

/// Trailing windows the page reports, in days.
pub const PERFORMANCE_WINDOWS: [i64; 2] =
    [RealizedWindow::Days30.days(), RealizedWindow::Days90.days()];
/// Weeks of selling the margin trend reaches back.
pub const MARGIN_TREND_WEEKS: i64 = 26;
/// How far before the trend pricing history is read, so its first change has a configuration
/// to compare with.
pub const PRICING_HISTORY_LEAD_DAYS: i64 = 56;
/// Weeks blended into the trailing margin that smooths week-to-week noise.
pub const TRAILING_MARGIN_WEEKS: i64 = 4;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// One sold lot of units: what it brought in, what it cost, and how long it was held.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoldUnitLine {
    pub order_number: String,
    pub sold_at: DateTime<Utc>,
    pub product_line: String,
    pub quantity: i64,
    /// The units' share of the order line's gross item sales.
    pub gross_cents: i64,
    /// Net proceeds after fees, postage and refunds; none while the order's are unknown.
    pub net_proceeds_cents: Option<i64>,
    /// Estimated or actual acquisition cost; none for an uncosted lot.
    pub cost_cents: Option<i64>,
    /// Days between receiving the lot and the sale.
    pub days_held: f64,
    /// The lot's market value at intake for these units, the basis of an estimated cost.
    pub intake_market_cents: Option<i64>,
    /// TCG market price for these units in the latest traded week before the sale.
    pub sale_market_cents: Option<i64>,
}

impl SoldUnitLine {
    /// Proceeds and cost, when both are known: only these count in the money figures.
    fn known(&self) -> Option<(i64, i64)> {
        self.net_proceeds_cents.zip(self.cost_cents)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummary {
    pub product_line: String,
    pub units_sold: i64,
    /// Units whose proceeds and cost are both known; every money figure covers only these.
    pub included_units: i64,
    /// Gross item sales of every sold unit, included or not.
    pub gross_cents: i64,
    /// Gross item sales of the included units: how much of the selling the money covers.
    pub included_gross_cents: i64,
    pub proceeds_cents: i64,
    pub cost_cents: i64,
    pub profit_cents: i64,
    /// Profit over net proceeds.
    pub margin_percent: Option<f64>,
    /// Profit over cost.
    pub markup_percent: Option<f64>,
    /// Profit spread over the days the window actually covers.
    pub profit_per_day_cents: Option<f64>,
    /// Profit over cost-days: the observed counterpart of the daily return hurdle.
    pub daily_return_percent: Option<f64>,
    pub average_days_held: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceWindow {
    pub window_days: i64,
    /// Days the window actually covers, bounded by the first sale on record.
    pub covered_days: f64,
    pub overall: PerformanceSummary,
    pub product_lines: Vec<PerformanceSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealizedPerformance {
    pub as_of: DateTime<Utc>,
    pub first_sale_at: Option<DateTime<Utc>>,
    pub windows: Vec<PerformanceWindow>,
}

/// `part` over `whole` as a percentage, when there is a whole to take it of.
fn percent(part: f64, whole: f64) -> Option<f64> {
    (whole > 0.0).then(|| part / whole * 100.0)
}

/// Days between two instants, with the fraction, each instant to the millisecond as JavaScript
/// holds it (`(b - a) / DAY_MS` in the Node app).
pub fn days_between(from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    (to.timestamp_millis() - from.timestamp_millis()) as f64 / DAY_MS
}

/// Margin, profit per day and return on capital of sold units spread over the days they cover.
pub fn summarize(
    product_line: &str,
    lines: &[&SoldUnitLine],
    covered_days: f64,
) -> PerformanceSummary {
    let included: Vec<(&SoldUnitLine, i64, i64)> = lines
        .iter()
        .filter_map(|l| l.known().map(|(net, cost)| (*l, net, cost)))
        .collect();
    let units_sold: i64 = lines.iter().map(|l| l.quantity).sum();
    let included_units: i64 = included.iter().map(|(l, ..)| l.quantity).sum();
    let proceeds_cents: i64 = included.iter().map(|(_, net, _)| net).sum();
    let cost_cents: i64 = included.iter().map(|(.., cost)| cost).sum();
    let profit_cents = proceeds_cents - cost_cents;
    // Capital at risk is never negative: a lot the seller was paid to take ties up nothing.
    let cost_days: f64 = included
        .iter()
        .map(|(l, _, cost)| (*cost).max(0) as f64 * l.days_held)
        .sum();
    let held_days: f64 = lines.iter().map(|l| l.days_held * l.quantity as f64).sum();
    let profit = profit_cents as f64;
    PerformanceSummary {
        product_line: product_line.to_owned(),
        units_sold,
        included_units,
        gross_cents: lines.iter().map(|l| l.gross_cents).sum(),
        included_gross_cents: included.iter().map(|(l, ..)| l.gross_cents).sum(),
        proceeds_cents,
        cost_cents,
        profit_cents,
        margin_percent: percent(profit, proceeds_cents as f64),
        markup_percent: percent(profit, cost_cents as f64),
        profit_per_day_cents: (included_units > 0 && covered_days > 0.0)
            .then(|| profit / covered_days),
        daily_return_percent: percent(profit, cost_days),
        average_days_held: (units_sold > 0).then(|| held_days / units_sold as f64),
    }
}

/// Realized margin, profit per day and return on capital over trailing windows, overall and by
/// product line.
pub fn summarize_realized(
    lines: &[SoldUnitLine],
    now: DateTime<Utc>,
    window_days: &[i64],
) -> RealizedPerformance {
    let first_sale = lines.iter().map(|l| l.sold_at).min();
    let windows = window_days
        .iter()
        .map(|&days| {
            let from = now - Duration::days(days);
            let in_window: Vec<&SoldUnitLine> =
                lines.iter().filter(|l| l.sold_at >= from).collect();
            let covered_days = match first_sale {
                None => 0.0,
                Some(first) => days_between(from.max(first), now).min(days as f64).max(1.0),
            };
            let mut by_line: Vec<(&str, Vec<&SoldUnitLine>)> = Vec::new();
            for line in &in_window {
                match by_line
                    .iter_mut()
                    .find(|(name, _)| *name == line.product_line)
                {
                    Some((_, group)) => group.push(line),
                    None => by_line.push((&line.product_line, vec![line])),
                }
            }
            let mut product_lines: Vec<PerformanceSummary> = by_line
                .iter()
                .map(|(name, group)| summarize(name, group, covered_days))
                .collect();
            product_lines.sort_by(|a, b| {
                b.proceeds_cents
                    .cmp(&a.proceeds_cents)
                    .then_with(|| collate::compare(&a.product_line, &b.product_line))
            });
            PerformanceWindow {
                window_days: days,
                covered_days,
                overall: summarize("All product lines", &in_window, covered_days),
                product_lines,
            }
        })
        .collect();
    RealizedPerformance {
        as_of: now,
        first_sale_at: first_sale,
        windows,
    }
}

/// The three things an estimated-cost margin moves with: what the card sells for against the
/// market, how far the market moved while it was held, and how much of the sale fees, postage
/// and refunds take.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginDrivers {
    /// Included units with a market price both at intake and when they sold.
    pub market_priced_units: i64,
    /// Sale price over the market price when it sold.
    pub price_to_market_percent: Option<f64>,
    /// Market price when it sold over the market price at intake.
    pub market_change_percent: Option<f64>,
    /// Net proceeds over gross item sales.
    pub net_to_gross_percent: Option<f64>,
}

pub fn summarize_drivers(lines: &[&SoldUnitLine]) -> MarginDrivers {
    let included: Vec<&SoldUnitLine> = lines
        .iter()
        .copied()
        .filter(|l| l.known().is_some())
        .collect();
    let priced: Vec<(&SoldUnitLine, i64, i64)> = included
        .iter()
        .filter_map(|l| match (l.intake_market_cents, l.sale_market_cents) {
            (Some(intake), Some(sale)) if intake > 0 && sale > 0 => Some((*l, intake, sale)),
            _ => None,
        })
        .collect();
    let sale_market: i64 = priced.iter().map(|(.., sale)| sale).sum();
    let intake_market: i64 = priced.iter().map(|(_, intake, _)| intake).sum();
    MarginDrivers {
        market_priced_units: priced.iter().map(|(l, ..)| l.quantity).sum(),
        price_to_market_percent: percent(
            priced.iter().map(|(l, ..)| l.gross_cents).sum::<i64>() as f64,
            sale_market as f64,
        ),
        market_change_percent: percent(sale_market as f64, intake_market as f64),
        net_to_gross_percent: percent(
            included
                .iter()
                .filter_map(|l| l.net_proceeds_cents)
                .sum::<i64>() as f64,
            included.iter().map(|l| l.gross_cents).sum::<i64>() as f64,
        ),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginTrendWeek {
    /// The Monday the week starts on (UTC), as YYYY-MM-DD.
    pub week_start: String,
    /// Whether the week was over as of the report; the current week is still filling.
    pub ended: bool,
    /// Days of the week with sales on record as of the report: 7 for a complete week.
    pub covered_days: f64,
    pub summary: PerformanceSummary,
    /// Margin over the trailing four weeks ending with this one, weighted by net proceeds.
    pub trailing_margin_percent: Option<f64>,
    pub drivers: MarginDrivers,
}

/// Midnight (UTC) on the Monday of the week `at` falls in.
fn monday_of(at: DateTime<Utc>) -> DateTime<Utc> {
    let day = at.date_naive();
    let monday = day - Duration::days(i64::from(day.weekday().num_days_from_monday()));
    Utc.from_utc_datetime(&monday.and_hms_opt(0, 0, 0).expect("midnight"))
}

/// Realized margin week by week, Monday to Sunday (UTC), from the first week with a sale (or
/// `weeks` back) to the current, possibly partial, week.
pub fn summarize_trend(
    lines: &[SoldUnitLine],
    now: DateTime<Utc>,
    weeks: i64,
) -> Vec<MarginTrendWeek> {
    let Some(first_sale) = lines.iter().map(|l| l.sold_at).min() else {
        return Vec::new();
    };
    let current_week = monday_of(now);
    let first_week = monday_of(first_sale).max(current_week - Duration::weeks(weeks - 1));
    let sold_between = |from: DateTime<Utc>, to: DateTime<Utc>| -> Vec<&SoldUnitLine> {
        lines
            .iter()
            .filter(|l| l.sold_at >= from && l.sold_at < to)
            .collect()
    };
    let mut out = Vec::new();
    let mut start = first_week;
    while start <= current_week {
        let end = start + Duration::weeks(1);
        let in_week = sold_between(start, end);
        let covered = days_between(start.max(first_sale), end.min(now)).clamp(1.0, 7.0);
        out.push(MarginTrendWeek {
            week_start: start.format("%Y-%m-%d").to_string(),
            ended: end <= now,
            covered_days: covered,
            summary: summarize("All product lines", &in_week, covered),
            trailing_margin_percent: summarize(
                "All product lines",
                &sold_between(end - Duration::weeks(TRAILING_MARGIN_WEEKS), end),
                1.0,
            )
            .margin_percent,
            drivers: summarize_drivers(&in_week),
        });
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn line(order: &str) -> SoldUnitLine {
        SoldUnitLine {
            order_number: order.into(),
            sold_at: at("2026-09-10T00:00:00Z"),
            product_line: "Pokemon".into(),
            quantity: 1,
            gross_cents: 1250,
            net_proceeds_cents: Some(1000),
            cost_cents: Some(750),
            days_held: 10.0,
            intake_market_cents: None,
            sale_market_cents: None,
        }
    }

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    #[test]
    fn realized_performance_summarizes_each_window_and_product_line() {
        let now = at("2026-09-17T00:00:00Z");
        let lines = [
            line("A"),
            SoldUnitLine {
                net_proceeds_cents: Some(2000),
                cost_cents: Some(1000),
                days_held: 20.0,
                quantity: 2,
                ..line("B")
            },
            SoldUnitLine {
                product_line: "YuGiOh".into(),
                net_proceeds_cents: Some(500),
                cost_cents: Some(600),
                days_held: 40.0,
                ..line("C")
            },
            SoldUnitLine {
                cost_cents: None,
                quantity: 3,
                ..line("D")
            },
            SoldUnitLine {
                sold_at: at("2026-06-01T00:00:00Z"),
                net_proceeds_cents: Some(100),
                cost_cents: Some(50),
                days_held: 5.0,
                ..line("E")
            },
        ];
        let report = summarize_realized(&lines, now, &[30, 90]);
        let (thirty, ninety) = (&report.windows[0], &report.windows[1]);
        assert_eq!(report.first_sale_at, Some(at("2026-06-01T00:00:00Z")));
        assert_eq!((thirty.covered_days, ninety.covered_days), (30.0, 90.0));
        let o = &thirty.overall;
        assert_eq!(
            (
                o.units_sold,
                o.included_units,
                o.gross_cents,
                o.included_gross_cents
            ),
            (7, 4, 5000, 3750)
        );
        assert_eq!(
            (o.proceeds_cents, o.cost_cents, o.profit_cents),
            (3500, 2350, 1150)
        );
        assert!(close(o.margin_percent, 1150.0 / 3500.0 * 100.0));
        assert!(close(o.markup_percent, 1150.0 / 2350.0 * 100.0));
        assert!(close(o.profit_per_day_cents, 1150.0 / 30.0));
        assert!(close(o.daily_return_percent, 1150.0 / 51_500.0 * 100.0));
        assert!(close(o.average_days_held, 120.0 / 7.0));
        let names: Vec<&str> = thirty
            .product_lines
            .iter()
            .map(|s| s.product_line.as_str())
            .collect();
        assert_eq!(names, ["Pokemon", "YuGiOh"]);
        assert_eq!(thirty.product_lines[1].profit_cents, -100);
        assert!(thirty.product_lines[1].daily_return_percent.unwrap() < 0.0);
        assert_eq!(
            ninety.overall.units_sold, 7,
            "the June sale is outside 90 days"
        );
        assert_eq!(ninety.overall.profit_per_day_cents, Some(1150.0 / 90.0));

        let paid_to_take = SoldUnitLine {
            net_proceeds_cents: Some(50),
            cost_cents: Some(-20),
            ..line("A")
        };
        let paid = &summarize_realized(&[paid_to_take], now, &[30]).windows[0].overall;
        assert_eq!(paid.profit_cents, 70);
        assert_eq!(
            (paid.daily_return_percent, paid.markup_percent),
            (None, None)
        );

        let recent = SoldUnitLine {
            sold_at: at("2026-09-12T00:00:00Z"),
            ..line("A")
        };
        assert_eq!(
            summarize_realized(&[recent], now, &[30]).windows[0].covered_days,
            5.0
        );

        let empty = &summarize_realized(&[], now, &[30]).windows[0];
        assert_eq!(empty.covered_days, 0.0);
        assert_eq!(
            (
                empty.overall.profit_per_day_cents,
                empty.overall.margin_percent
            ),
            (None, None)
        );
    }

    fn trend_line(sold_at: &str) -> SoldUnitLine {
        SoldUnitLine {
            sold_at: at(sold_at),
            gross_cents: 1000,
            net_proceeds_cents: Some(800),
            cost_cents: Some(700),
            intake_market_cents: Some(1000),
            sale_market_cents: Some(1000),
            ..line("A")
        }
    }

    #[test]
    fn the_margin_trend_runs_week_by_week_with_a_trailing_margin() {
        let now = at("2026-10-08T00:00:00Z");
        let lines = [
            trend_line("2026-09-07T03:00:00Z"),
            SoldUnitLine {
                net_proceeds_cents: Some(1000),
                ..trend_line("2026-09-20T23:00:00Z")
            },
            SoldUnitLine {
                cost_cents: Some(760),
                ..trend_line("2026-09-29T00:00:00Z")
            },
            SoldUnitLine {
                cost_cents: None,
                ..trend_line("2026-10-06T00:00:00Z")
            },
            SoldUnitLine {
                cost_cents: Some(600),
                ..trend_line("2026-10-07T00:00:00Z")
            },
        ];
        let weeks = summarize_trend(&lines, now, MARGIN_TREND_WEEKS);
        let starts: Vec<&str> = weeks.iter().map(|w| w.week_start.as_str()).collect();
        assert_eq!(
            starts,
            [
                "2026-09-07",
                "2026-09-14",
                "2026-09-21",
                "2026-09-28",
                "2026-10-05"
            ]
        );
        assert_eq!(weeks[0].summary.units_sold, 1);
        assert_eq!(
            weeks[1].summary.units_sold, 1,
            "a Sunday sale stays in its week"
        );
        assert_eq!(
            (weeks[2].summary.units_sold, weeks[2].summary.margin_percent),
            (0, None)
        );
        assert!(close(weeks[3].summary.margin_percent, 5.0));
        assert!((weeks[0].covered_days - (7.0 - 3.0 / 24.0)).abs() < 1e-9);
        assert_eq!(weeks[4].covered_days, 3.0);
        assert_eq!(
            weeks.iter().map(|w| w.ended).collect::<Vec<_>>(),
            [true, true, true, true, false]
        );
        assert_eq!(weeks[4].summary.included_units, 1);
        assert_eq!(
            weeks[4].summary.included_gross_cents * 2,
            weeks[4].summary.gross_cents
        );
        assert!(close(
            weeks[3].trailing_margin_percent,
            440.0 / 2600.0 * 100.0
        ));
        assert!(close(
            weeks[4].trailing_margin_percent,
            540.0 / 2600.0 * 100.0
        ));
        assert_eq!(
            summarize_trend(&[trend_line("2026-01-05T00:00:00Z")], now, 3)[0].week_start,
            "2026-09-21"
        );
        assert!(summarize_trend(&[], now, MARGIN_TREND_WEEKS).is_empty());
    }

    #[test]
    fn margin_drivers_compare_sales_with_the_market() {
        let t = || trend_line("2026-09-09T12:00:00Z");
        let lines = [
            SoldUnitLine {
                quantity: 2,
                gross_cents: 2100,
                net_proceeds_cents: Some(1700),
                intake_market_cents: Some(2000),
                sale_market_cents: Some(1900),
                ..t()
            },
            SoldUnitLine {
                gross_cents: 900,
                net_proceeds_cents: Some(700),
                intake_market_cents: Some(1000),
                sale_market_cents: Some(1100),
                ..t()
            },
            SoldUnitLine {
                gross_cents: 500,
                net_proceeds_cents: Some(400),
                intake_market_cents: None,
                sale_market_cents: Some(600),
                ..t()
            },
            SoldUnitLine {
                gross_cents: 500,
                net_proceeds_cents: Some(400),
                cost_cents: None,
                ..t()
            },
        ];
        let drivers = summarize_drivers(&lines.iter().collect::<Vec<_>>());
        assert_eq!(drivers.market_priced_units, 3);
        assert_eq!(drivers.price_to_market_percent, Some(100.0));
        assert!(close(drivers.market_change_percent, 100.0));
        assert!(close(drivers.net_to_gross_percent, 2800.0 / 3500.0 * 100.0));
        let unpriced = summarize_drivers(&[&SoldUnitLine {
            intake_market_cents: None,
            ..t()
        }]);
        assert_eq!(
            (
                unpriced.price_to_market_percent,
                unpriced.market_change_percent
            ),
            (None, None)
        );
        assert_eq!(unpriced.net_to_gross_percent, Some(80.0));
    }
}
