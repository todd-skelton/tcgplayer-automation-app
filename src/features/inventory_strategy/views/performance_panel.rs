use corten::{i18n::DateStyle, prelude::*};

use super::{
    format::{
        cents, count, days, dollars, fixed, per_day, percent, percent_per_day, signed_dollars,
    },
    strategy_screen::{Chip, Mood, Stat},
};
use crate::{
    features::inventory_strategy::{
        levers::{HurdleChange, Lever, LineReturn},
        performance::{PerformanceSummary, PerformanceWindow},
        pricing_changes::format_hurdle,
        screen::Screen,
    },
    layout::{Notice, Tone},
    text::Msg,
    theme::*,
};

/// Which realized window the screen shows: the realized figures and the levers read from it.
/// Radios and the stylesheet switch them (`:has`), with or without JavaScript, as the React
/// screen's toggle switched its state; corten-ui's tabs show only panels inside them.
#[component(css = super::strategy_screen::StrategyScreen)]
fn WindowChoice<'a>(windows: &'a [PerformanceWindow]) -> impl Render {
    html! {
        <fieldset class={WindowChoice}>
            <legend class={VisuallyHidden}>"Performance window"</legend>
            for (i, window) in windows.iter().enumerate() {
                <label>
                    <input
                        type="radio"
                        name="performance-window"
                        value={window.window_days}
                        checked={i == 0}
                    >
                    <span>{window.window_days}" days"</span>
                </label>
            }
        </fieldset>
    }
}

/// What the current strategy has actually earned: margin, profit per day, and return on capital
/// from sold units, against the configured hurdle.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn PerformancePanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let hurdle = screen.hurdle();
    let windows = screen.windows();
    html! {
        <section class={panel()} aria-labelledby="realized-performance">
            <div class={Title}>
                <h2 id="realized-performance">"Realized performance"</h2>
                for window in windows {
                    if let Some(rate) = window.overall.daily_return_percent {
                        <span class={Window} data-window={window.window_days}>
                            <Chip
                                mood={if rate >= hurdle * 100.0 { Mood::Good } else { Mood::Caution }}
                                label={&format!(
                                    "{} on capital \u{b7} hurdle {}",
                                    percent_per_day(Some(rate), ""),
                                    format_hurdle(hurdle)
                                )}
                            />
                        </span>
                    }
                }
                <span class={Grow}></span>
                if !windows.is_empty() {
                    <WindowChoice windows={windows} />
                }
            </div>
            <p class={muted()}>
                "Sold units at their share of the order's net proceeds after fees, postage, and refunds, less the lot's cost. Costs are the estimated purchase rule unless recorded."
            </p>
            if let Some(error) = screen.performance_error {
                <Notice tone={Tone::Warning}>{error}</Notice>
            }
            if windows.is_empty() {
                <p class={muted()}>"No sold units with proceeds and cost in this window yet."</p>
            }
            for window in windows {
                <div class={Window} data-window={window.window_days}>
                    <WindowFigures window={window} t={t} />
                </div>
            }
            if let Some(report) = &screen.performance {
                <p class={(muted(), Caption)}>
                    "As of "{t.date(report.as_of, DateStyle::Short).zone(screen.visitor)}
                    if let Some(first) = report.first_sale_at {
                        " \u{b7} sales on record since "
                        {t.date(first, DateStyle::Short).zone(screen.visitor)}
                    }
                    ". Opening-balance lots count as held since the inventory was first observed."
                </p>
            }
        </section>
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn WindowFigures<'a>(window: &'a PerformanceWindow, t: Msg) -> impl Render {
    let o = &window.overall;
    let excluded_units = o.units_sold - o.included_units;
    let excluded = if excluded_units > 0 {
        format!(
            " \u{b7} {} units ({} of {} in sales) without cost or proceeds excluded",
            count(t, excluded_units),
            cents(t, o.gross_cents - o.included_gross_cents),
            cents(t, o.gross_cents)
        )
    } else {
        String::new()
    };
    html! {
        if o.units_sold == 0 {
            <p class={muted()}>"No sold units with proceeds and cost in this window yet."</p>
        } else {
            <div class={Stats}>
                <Stat
                    label="Profit per day"
                    value={&o.profit_per_day_cents.map_or_else(
                        || "Unavailable".to_owned(),
                        |c| format!("{}/day", dollars(t, c / 100.0)),
                    )}
                    detail={&format!(
                        "{} profit over {} days",
                        cents(t, o.profit_cents),
                        fixed(window.covered_days, 0)
                    )}
                />
                <Stat
                    label="Margin"
                    value={&percent(o.margin_percent, "Unavailable")}
                    detail={&format!(
                        "Profit over net proceeds \u{b7} {} over cost",
                        percent(o.markup_percent, "Unavailable")
                    )}
                />
                <Stat
                    label="Return on capital"
                    value={&percent_per_day(o.daily_return_percent, "Unavailable")}
                    detail={&format!(
                        "Profit over cost-days \u{b7} held {} on average",
                        days(o.average_days_held, "Unavailable")
                    )}
                />
                <Stat
                    label="Sold"
                    value={&format!("{} units", count(t, o.units_sold))}
                    detail={&format!(
                        "{} net proceeds \u{b7} {} cost{excluded}",
                        cents(t, o.proceeds_cents),
                        cents(t, o.cost_cents)
                    )}
                />
            </div>
            <LineTable lines={&window.product_lines} t={t} />
        }
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn LineTable<'a>(lines: &'a [PerformanceSummary], t: Msg) -> impl Render {
    html! {
        if !lines.is_empty() {
            <div class={Scroll}>
                <table class={Table} aria-label="Realized performance by product line">
                    <thead>
                        <tr>
                            <th>"Product line"</th>
                            <th class={End}>"Sold"</th>
                            <th class={End}>"Net proceeds"</th>
                            <th class={End}>"Cost"</th>
                            <th class={End}>"Profit"</th>
                            <th class={End}>"Margin"</th>
                            <th class={End}>"Return on capital"</th>
                            <th class={End}>"Days held"</th>
                        </tr>
                    </thead>
                    <tbody>
                        for line in lines {
                            <tr key={&line.product_line}>
                                <th scope="row">{&line.product_line}</th>
                                <td class={End}>{count(t, line.units_sold)}</td>
                                <td class={End}>{cents(t, line.proceeds_cents)}</td>
                                <td class={End}>{cents(t, line.cost_cents)}</td>
                                <td class={End}>{cents(t, line.profit_cents)}</td>
                                <td class={End}>{percent(line.margin_percent, "Unavailable")}</td>
                                <td class={End}>
                                    {percent_per_day(line.daily_return_percent, "Unavailable")}
                                </td>
                                <td class={End}>{days(line.average_days_held, "Unavailable")}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        }
    }
}

/// What to change next, with the numbers behind each suggestion.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn Levers<'a>(levers: &'a [Lever], t: Msg) -> impl Render {
    html! {
        <section class={panel()} aria-label="How to improve">
            <h2>"How to improve"</h2>
            if levers.is_empty() {
                <p class={muted()}>
                    "Nothing stands out: the configured hurdle is the best on the ladder and every product line is clearing it."
                </p>
            } else {
                <ul class={LeverList}>
                    for lever in levers {
                        let (title, detail) = worded(lever, t);
                        <li>
                            <strong>{title}</strong>
                            <span class={muted()}>{detail}</span>
                        </li>
                    }
                </ul>
            }
        </section>
    }
}

/// A lever's title and detail, as `improvementLevers.ts` wrote them.
pub fn worded(lever: &Lever, t: Msg) -> (String, String) {
    let line = |l: &LineReturn| {
        format!(
            "{} returned {} on {} of cost",
            l.product_line,
            percent_per_day(Some(l.daily_return_percent), ""),
            cents(t, l.cost_cents)
        )
    };
    let names = |lines: &[LineReturn]| {
        lines
            .iter()
            .map(|l| l.product_line.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    match lever {
        Lever::ChangeHurdle {
            raise,
            to,
            models,
            configured_models,
            change,
        } => {
            let change = change.as_ref().map_or_else(String::new, |c: &HurdleChange| {
                format!(
                    " \u{b7} {} listed value \u{b7} {} days median wait",
                    signed_dollars(t, c.listed_value_dollars),
                    fixed(c.median_wait_days, 1)
                )
            });
            (
                format!(
                    "{} the hurdle to {}",
                    if *raise { "Raise" } else { "Lower" },
                    per_day(*to)
                ),
                format!(
                    "Models {} on capital against {} now{change}. Change it in the pricing configuration; the next pricing run applies it.",
                    per_day(*models),
                    configured_models.map_or_else(|| "the configured hurdle".to_owned(), per_day)
                ),
            )
        }
        Lever::BelowHurdle {
            realized_percent,
            hurdle_percent,
        } => (
            "Sales are returning less than the hurdle assumes".into(),
            format!(
                "Realized {} on capital against a {} hurdle. Either prices are set for faster turns than buyers deliver, or capital sits in lots that take long to sell; check the slow product lines below.",
                percent_per_day(Some(*realized_percent), ""),
                percent_per_day(Some(*hurdle_percent), "")
            ),
        ),
        Lever::ClearingHurdle {
            realized_percent,
            hurdle_percent,
        } => (
            "Sales are clearing the hurdle".into(),
            format!(
                "Realized {} on capital against a {} hurdle. Growth comes from more inventory at the same terms, or from a higher hurdle if the sweep shows it holds.",
                percent_per_day(Some(*realized_percent), ""),
                percent_per_day(Some(*hurdle_percent), "")
            ),
        ),
        Lever::LinesBelowHurdle(lines) => (
            format!("Below the hurdle: {}", names(lines)),
            lines
                .iter()
                .map(|l| {
                    format!(
                        "{}, held {} days on average",
                        line(l),
                        l.average_days_held
                            .map_or_else(|| "?".to_owned(), |d| fixed(d, 0))
                    )
                })
                .collect::<Vec<_>>()
                .join("; ")
                + ". Buy less of these at the current terms, or reprice them to sell sooner.",
        ),
        Lever::LinesWellAboveHurdle(lines) => (
            format!("Well above the hurdle: {}", names(lines)),
            lines.iter().map(line).collect::<Vec<_>>().join("; ")
                + ". More capital here at the same purchase terms raises profit per day fastest.",
        ),
        Lever::ProceedsWaiting { cents: c, oldest_days } => (
            format!("{} of proceeds not yet republished", cents(t, *c)),
            format!(
                "{}Cash that is not on sale earns nothing; publishing replacement inventory sooner shortens every cycle.",
                oldest_days.map_or_else(String::new, |d| format!(
                    "The oldest has waited {} days. ",
                    fixed(d, 0)
                ))
            ),
        ),
        Lever::UnforecastUnits { count: n } => (
            format!("{} listed units have no forecast", count(t, *n)),
            "These SKUs had no usable sales history when priced, so they follow the market or listing reference instead of the policy. The hurdle sweep and verdict leave them out.".into(),
        ),
    }
}
