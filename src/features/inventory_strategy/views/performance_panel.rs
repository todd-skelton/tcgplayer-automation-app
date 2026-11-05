use corten::{Href, i18n::DateStyle, prelude::*};
use corten_ui::{ChoiceGroup, ChoiceOption, Chosen, ShownFor};

use super::format::{
    cents, count, days, dollars, fixed, per_day, percent, percent_per_day, signed_dollars,
};
use crate::{
    features::inventory_strategy::{
        levers::{HurdleChange, Lever, LineReturn},
        performance::{PerformanceSummary, PerformanceWindow, RealizedWindow},
        pricing_changes::format_hurdle,
        screen::Screen,
        url::{InventoryStrategy, View},
    },
    layout::Notice,
    text::Msg,
    theme::*,
    ui::alert::AlertVariant,
    ui::{
        badge::{Badge, BadgeEmphasis, BadgeTone},
        card::{CardCompact, CardPanel},
        segmented::Segmented,
        stats::{Stat, StatTone, Stats, StatsSurface},
        table::{Table, TableLayout, TableNumeric},
    },
};

#[derive(Id)]
pub struct RealizedWindowId;

/// The realized window the page shows, from its address: the figures and the levers follow it
/// wherever they are drawn.
pub fn realized_choice(screen: &Screen) -> Chosen<RealizedWindowId, RealizedWindow> {
    Chosen {
        id: RealizedWindowId,
        value: screen.view.realized.unwrap_or_default(),
    }
}

/// Which realized window the screen shows, as the React screen's toggle chose it. Each option
/// is the page with that window, so it works without JavaScript too.
#[component]
fn WindowChoice<'a>(
    screen: &'a Screen,
    choice: &'a Chosen<RealizedWindowId, RealizedWindow>,
) -> impl Render {
    let links: Vec<(RealizedWindow, InventoryStrategy)> = screen
        .windows()
        .iter()
        .filter_map(|w| RealizedWindow::of(w.window_days))
        .map(|w| {
            let view = View {
                realized: (w != RealizedWindow::default()).then_some(w),
                ..screen.view.clone()
            };
            (w, InventoryStrategy { view })
        })
        .collect();
    html! {
        let options: Vec<ChoiceOption<'_, RealizedWindow, String>> = links
            .iter()
            .map(|(w, link)| ChoiceOption {
                value: *w,
                label: format!("{} days", w.days()),
                link: Some(link as &dyn Href),
            })
            .collect();
        <Segmented>
            <ChoiceGroup choice={choice} label="Performance window" options={&options} />
        </Segmented>
    }
}

/// What the current strategy has actually earned: margin, profit per day, and return on capital
/// from sold units, against the configured hurdle.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn PerformancePanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let hurdle = screen.hurdle();
    let windows = screen.windows();
    let choice = realized_choice(screen);
    html! {
        <section class={(CardPanel {}, CardCompact {})} aria-labelledby="realized-performance">
            <div class={Title}>
                <h2 id="realized-performance">"Realized performance"</h2>
                for (window, shown) in windows.iter().filter_map(|w| Some((w, RealizedWindow::of(w.window_days)?))) {
                    if let Some(rate) = window.overall.daily_return_percent {
                        <ShownFor choice={&choice} values={&[shown]}>
                            <span
                                class={Badge { tone: if rate >= hurdle * 100.0 { BadgeTone::Success } else { BadgeTone::Warning }, emphasis: BadgeEmphasis::Soft }}
                            >
                                {&format!(
                                        "{} on capital \u{b7} hurdle {}",
                                        percent_per_day(Some(rate), ""),
                                        format_hurdle(hurdle)
                                    )}
                            </span>
                        </ShownFor>
                    }
                }
                <span class={Grow}></span>
                if !windows.is_empty() {
                    <WindowChoice screen={screen} choice={&choice} />
                }
            </div>
            <p class={muted()}>
                "Sold units at their share of the order's net proceeds after fees, postage, and refunds, less the lot's cost. Costs are the estimated purchase rule unless recorded."
            </p>
            if let Some(error) = screen.performance_error {
                <Notice variant={AlertVariant::Warning}>{error}</Notice>
            }
            if windows.is_empty() {
                <p class={muted()}>"No sold units with proceeds and cost in this window yet."</p>
            }
            for (window, shown) in windows.iter().filter_map(|w| Some((w, RealizedWindow::of(w.window_days)?))) {
                <ShownFor choice={&choice} values={&[shown]}>
                    <WindowFigures window={window} t={t} />
                </ShownFor>
            }
            if let Some(report) = &screen.performance {
                <p class={(muted(), Caption)}>
                    "As of "{t.date(report.as_of, DateStyle::Short)}
                    if let Some(first) = report.first_sale_at {
                        " \u{b7} sales on record since "
                        {t.date(first, DateStyle::Short)}
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
            <dl class={Stats { surface: StatsSurface::Plain }}>
                <Stat
                    label="Profit per day"
                    value={&o.profit_per_day_cents.map_or_else(
                        || "Unavailable".to_owned(),
                        |c| format!("{}/day", dollars(t, c / 100.0)),
                    )}
                    note={&format!(
                        "{} profit over {} days",
                        cents(t, o.profit_cents),
                        fixed(window.covered_days, 0)
                    )}
                    tone={StatTone::Neutral}
                />
                <Stat
                    label="Margin"
                    value={&percent(o.margin_percent, "Unavailable")}
                    note={&format!(
                        "Profit over net proceeds \u{b7} {} over cost",
                        percent(o.markup_percent, "Unavailable")
                    )}
                    tone={StatTone::Neutral}
                />
                <Stat
                    label="Return on capital"
                    value={&percent_per_day(o.daily_return_percent, "Unavailable")}
                    note={&format!(
                        "Profit over cost-days \u{b7} held {} on average",
                        days(o.average_days_held, "Unavailable")
                    )}
                    tone={StatTone::Neutral}
                />
                <Stat
                    label="Sold"
                    value={&format!("{} units", count(t, o.units_sold))}
                    note={&format!(
                        "{} net proceeds \u{b7} {} cost{excluded}",
                        cents(t, o.proceeds_cents),
                        cents(t, o.cost_cents)
                    )}
                    tone={StatTone::Neutral}
                />
            </dl>
            <LineTable lines={&window.product_lines} t={t} />
        }
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn LineTable<'a>(lines: &'a [PerformanceSummary], t: Msg) -> impl Render {
    html! {
        if !lines.is_empty() {
            <Table layout={TableLayout::Scroll}>
                <table class={Cells} aria-label="Realized performance by product line">
                    <thead>
                        <tr>
                            <th>"Product line"</th>
                            <th class={TableNumeric {}}>"Sold"</th>
                            <th class={TableNumeric {}}>"Net proceeds"</th>
                            <th class={TableNumeric {}}>"Cost"</th>
                            <th class={TableNumeric {}}>"Profit"</th>
                            <th class={TableNumeric {}}>"Margin"</th>
                            <th class={TableNumeric {}}>"Return on capital"</th>
                            <th class={TableNumeric {}}>"Days held"</th>
                        </tr>
                    </thead>
                    <tbody>
                        for line in lines {
                            <tr key={&line.product_line}>
                                <th scope="row">{&line.product_line}</th>
                                <td class={TableNumeric {}}>{count(t, line.units_sold)}</td>
                                <td class={TableNumeric {}}>{cents(t, line.proceeds_cents)}</td>
                                <td class={TableNumeric {}}>{cents(t, line.cost_cents)}</td>
                                <td class={TableNumeric {}}>{cents(t, line.profit_cents)}</td>
                                <td class={TableNumeric {}}>
                                    {percent(line.margin_percent, "Unavailable")}
                                </td>
                                <td class={TableNumeric {}}>
                                    {percent_per_day(line.daily_return_percent, "Unavailable")}
                                </td>
                                <td class={TableNumeric {}}>
                                    {days(line.average_days_held, "Unavailable")}
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            </Table>
        }
    }
}

/// What to change next, with the numbers behind each suggestion.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn Levers<'a>(levers: &'a [Lever], t: Msg) -> impl Render {
    html! {
        <section class={(CardPanel {}, CardCompact {})} aria-label="How to improve">
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
