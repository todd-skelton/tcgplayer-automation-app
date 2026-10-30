use chrono::NaiveDate;
use corten::prelude::*;

use super::format::{count, fixed, month_day, percent, percent_per_day};
use crate::{
    features::{
        inventory_economics::estimate::CostRate,
        inventory_strategy::{
            performance::{MarginTrendWeek, TRAILING_MARGIN_WEEKS},
            realized::MarginTrend,
        },
    },
    text::Msg,
    theme::*,
};

/// Share of a week's sales that must be costed for its margin to be read as complete.
const COSTED_SALES_THRESHOLD: f64 = 0.9;

const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 220.0;
const PAD_TOP: f64 = 20.0;
const PAD_RIGHT: f64 = 16.0;
const PAD_BOTTOM: f64 = 28.0;
const PAD_LEFT: f64 = 44.0;

fn costed_share(week: &MarginTrendWeek) -> f64 {
    if week.summary.gross_cents > 0 {
        week.summary.included_gross_cents as f64 / week.summary.gross_cents as f64
    } else {
        0.0
    }
}

fn complete(week: &MarginTrendWeek) -> bool {
    week.ended && costed_share(week) >= COSTED_SALES_THRESHOLD
}

fn day(iso: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()
}

/// The chart's geometry, as the React chart laid it out.
struct Plot {
    low: f64,
    high: f64,
    step: f64,
    first: Option<NaiveDate>,
}

impl Plot {
    fn of(weeks: &[MarginTrendWeek]) -> Option<Plot> {
        let values: Vec<f64> = weeks
            .iter()
            .flat_map(|w| [w.summary.margin_percent, w.trailing_margin_percent])
            .flatten()
            .collect();
        if values.is_empty() {
            return None;
        }
        let min = values.iter().copied().fold(f64::INFINITY, f64::min);
        let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Some(Plot {
            low: 0f64.min((min / 5.0).floor() * 5.0),
            high: 5f64.max((max / 5.0).ceil() * 5.0),
            step: (WIDTH - PAD_LEFT - PAD_RIGHT) / (weeks.len().max(1) as f64),
            first: weeks.first().and_then(|w| day(&w.week_start)),
        })
    }

    /// A week's point sits at its middle.
    fn x_of_week(&self, index: usize) -> f64 {
        PAD_LEFT + self.step * (index as f64 + 0.5)
    }

    /// A date sits at its share of the week.
    fn x_of_day(&self, iso: &str) -> Option<f64> {
        let days = (day(iso)? - self.first?).num_days() as f64;
        Some(PAD_LEFT + self.step * (days / 7.0))
    }

    fn y(&self, value: f64) -> f64 {
        let plot_height = HEIGHT - PAD_TOP - PAD_BOTTOM;
        PAD_TOP + plot_height * (1.0 - (value - self.low) / (self.high - self.low))
    }

    fn path(&self, weeks: &[MarginTrendWeek], pick: fn(&MarginTrendWeek) -> Option<f64>) -> String {
        weeks
            .iter()
            .enumerate()
            .filter_map(|(i, w)| pick(w).map(|v| (self.x_of_week(i), self.y(v))))
            .enumerate()
            .map(|(i, (x, y))| {
                format!(
                    "{}{},{}",
                    if i == 0 { "M" } else { "L" },
                    fixed(x, 1),
                    fixed(y, 1)
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Every 5%, or every 10% when that would be more than eight lines.
    fn gridlines(&self) -> Vec<f64> {
        let count = ((self.high - self.low) / 5.0) as usize + 1;
        (0..count)
            .map(|i| self.low + i as f64 * 5.0)
            .filter(|v| count <= 8 || v.rem_euclid(10.0) == 0.0)
            .collect()
    }
}

/// Weekly realized margin (thin line), the trailing four weeks' (bold), and the days pricing
/// changed (dashed, numbered as the list below). A point's title names its week and margin.
#[component(css = super::strategy_screen::StrategyScreen)]
fn Chart<'a>(trend: &'a MarginTrend, t: Msg) -> impl Render {
    let weeks = &trend.weeks;
    let plot = Plot::of(weeks);
    html! {
        if let Some(plot) = plot {
            <svg
                class={Chart}
                viewBox={format!("0 0 {WIDTH} {HEIGHT}")}
                role="img"
                aria-label="Weekly realized margin with the trailing four-week margin"
            >
                for value in plot.gridlines() {
                    <g>
                        <line
                            class={if value == 0.0 { Zero } else { Grid }}
                            x1={PAD_LEFT}
                            x2={WIDTH - PAD_RIGHT}
                            y1={plot.y(value)}
                            y2={plot.y(value)}
                        ></line>
                        <text
                            class={Axis}
                            x={PAD_LEFT - 6.0}
                            y={plot.y(value) + 4.0}
                            text-anchor="end"
                        >
                            {value}"%"
                        </text>
                    </g>
                }
                for (i, change) in trend.pricing_changes.iter().enumerate() {
                    if let Some(x) = plot.x_of_day(&change.changed_on).filter(|x| (PAD_LEFT..=WIDTH - PAD_RIGHT).contains(x)) {
                        <g>
                            <line
                                class={Change}
                                x1={x}
                                x2={x}
                                y1={PAD_TOP}
                                y2={HEIGHT - PAD_BOTTOM}
                            ></line>
                            <text class={ChangeLabel} x={x} y={PAD_TOP - 6.0} text-anchor="middle">
                                {i + 1}
                            </text>
                        </g>
                    }
                }
                <path class={WeekLine} d={plot.path(weeks, |w| w.summary.margin_percent)}></path>
                <path class={TrailingLine} d={plot.path(weeks, |w| w.trailing_margin_percent)}></path>
                for (i, week) in weeks.iter().enumerate() {
                    if let Some(margin) = week.summary.margin_percent {
                        <circle
                            class={(Point, (!complete(week)).then_some(Hollow))}
                            cx={plot.x_of_week(i)}
                            cy={plot.y(margin)}
                            r="4"
                        >
                            <title>
                                "Week of "{month_day(t, &week.week_start)}": "
                                {percent(Some(margin), "N/A")}
                            </title>
                        </circle>
                    }
                }
                for (i, week) in weeks.iter().enumerate() {
                    if i % weeks.len().div_ceil(9) == 0 {
                        <text
                            class={Axis}
                            x={plot.x_of_week(i)}
                            y={HEIGHT - 8.0}
                            text-anchor="middle"
                        >
                            {month_day(t, &week.week_start)}
                        </text>
                    }
                }
            </svg>
        }
    }
}

/// Realized margin week by week, smoothed over four weeks, with the price, market, and fee ratios
/// that move it and the days pricing changed.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn MarginTrendPanel<'a>(trend: Option<&'a MarginTrend>, t: Msg) -> impl Render {
    let rule = CostRate::DEFAULT;
    html! {
        if let Some(trend) = trend.filter(|t| !t.weeks.is_empty()) {
            <section class={panel()} aria-labelledby="margin-over-time">
                <h2 id="margin-over-time">"Margin over time"</h2>
                <p class={muted()}>
                    "Each week's realized margin (thin line) and the margin over the trailing "
                    {TRAILING_MARGIN_WEEKS}
                    " weeks (bold line). Hollow points are weeks still in progress or with less than "
                    {COSTED_SALES_THRESHOLD * 100.0}
                    "% of sales costed. Estimated costs are "
                    {rule.market_rate * 100.0}
                    "% of the market price at intake less "
                    {super::format::cents(t, rule.per_unit_deduction_cents)}
                    " a card unless a batch was given its own rate, so margin follows three ratios: the sale price against the market when it sold, how the market moved since intake, and what fees, postage, and refunds leave of the sale."
                </p>
                <Chart trend={trend} t={t} />
                if !trend.pricing_changes.is_empty() {
                    <ol class={Changes}>
                        for change in &trend.pricing_changes {
                            <li>
                                {month_day(t, &change.changed_on)}": "{change.changes.join("; ")}
                            </li>
                        }
                    </ol>
                }
                <div class={Scroll}>
                    <table class={Table} aria-label="Realized margin by week">
                        <thead>
                            <tr>
                                <th>"Week of"</th>
                                <th class={End}>"Sold"</th>
                                <th class={End}>"Sales costed"</th>
                                <th class={End}>"Margin"</th>
                                <th class={End}>{TRAILING_MARGIN_WEEKS}"-week margin"</th>
                                <th class={End}>"Return on capital"</th>
                                <th class={End}>"Price vs market"</th>
                                <th class={End}>"Market since intake"</th>
                                <th class={End}>"Net of fees"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for week in trend.weeks.iter().rev() {
                                <tr key={&week.week_start}>
                                    <th scope="row" class={NoWrap}>
                                        {month_day(t, &week.week_start)}
                                        if !week.ended { " (so far)" }
                                    </th>
                                    <td class={End}>{count(t, week.summary.units_sold)}</td>
                                    <td class={End}>
                                        if week.summary.gross_cents > 0 {
                                            {(costed_share(week) * 100.0).round()}"%"
                                        } else {
                                            "N/A"
                                        }
                                    </td>
                                    <td class={End}>
                                        {percent(week.summary.margin_percent, "N/A")}
                                    </td>
                                    <td class={End}>
                                        {percent(week.trailing_margin_percent, "N/A")}
                                    </td>
                                    <td class={End}>
                                        {percent_per_day(week.summary.daily_return_percent, "N/A")}
                                    </td>
                                    <td class={End}>
                                        {percent(week.drivers.price_to_market_percent, "N/A")}
                                    </td>
                                    <td class={End}>
                                        {percent(week.drivers.market_change_percent, "N/A")}
                                    </td>
                                    <td class={End}>
                                        {percent(week.drivers.net_to_gross_percent, "N/A")}
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gridlines_thin_to_tens_past_eight() {
        let plot = |low, high| Plot {
            low,
            high,
            step: 1.0,
            first: None,
        };
        assert_eq!(plot(0.0, 20.0).gridlines(), [0.0, 5.0, 10.0, 15.0, 20.0]);
        assert_eq!(
            plot(-10.0, 40.0).gridlines(),
            [-10.0, 0.0, 10.0, 20.0, 30.0, 40.0]
        );
    }
}
