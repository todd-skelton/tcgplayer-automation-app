use corten::prelude::*;

use super::{
    format::{age, count, coverage, days_delta, delta_dollars, dollars, fixed, per_day},
    strategy_screen::{Chip, Mood, Stat},
};
use crate::{
    features::inventory_strategy::{
        dashboard::{ProductLine, Role},
        pricing_changes::{describe_policy, format_hurdle},
        screen::Screen,
        verdict::HurdleReturn,
    },
    text::Msg,
    theme::*,
};

/// The active policy, and how many product lines price at a hurdle of their own.
fn policy_label(screen: &Screen) -> String {
    let label = describe_policy(&screen.config);
    if !screen.profit_per_day() {
        return label;
    }
    let hurdle = screen.hurdle();
    let own = screen
        .dashboard
        .product_lines
        .iter()
        .filter(|line| {
            line.hurdle_sweep
                .iter()
                .find(|s| s.configured)
                .map(|s| s.daily_return_hurdle)
                != Some(hurdle)
        })
        .count();
    match own {
        0 => label,
        1 => format!("{label}, 1 product line at their own"),
        n => format!("{label}, {n} product lines at their own"),
    }
}

/// What the best hurdle offers over the configured one: its value and why.
fn alternative(
    best: Option<&HurdleReturn<'_>>,
    configured: Option<&HurdleReturn<'_>>,
    t: Msg,
) -> (String, String) {
    let Some(best) = best else {
        return (
            "None".into(),
            "No hurdle on the ladder has a positive modeled daily return at these inputs".into(),
        );
    };
    if best.scenario.configured {
        return (
            "Configured hurdle".into(),
            format!(
                "Highest simplified full-reinvestment return on the ladder at {}",
                per_day(best.daily_return)
            ),
        );
    }
    let change = configured
        .and_then(|c| {
            Some((
                c,
                c.scenario.summary.estimated_time?,
                best.scenario.summary.estimated_time?,
            ))
        })
        .map_or_else(String::new, |(c, now, then)| {
            format!(
                " \u{b7} {} listed \u{b7} {} median wait",
                delta_dollars(
                    t,
                    best.scenario.summary.physical_value - c.scenario.summary.physical_value
                ),
                days_delta(then.median_days - now.median_days)
            )
        });
    (
        format_hurdle(best.scenario.daily_return_hurdle),
        format!(
            "{}{}{change}",
            per_day(best.daily_return),
            configured.map_or_else(String::new, |c| format!(
                " against {} configured",
                per_day(c.daily_return)
            ))
        ),
    )
}

/// How old the saved curves are.
fn curve_age(overall: &ProductLine, screen: &Screen) -> String {
    let (Some(newest), Some(oldest)) = (&overall.newest_pricing_at, &overall.oldest_pricing_at)
    else {
        return "no saved curves".into();
    };
    let newest = age(Some(newest), screen.now).to_lowercase();
    let oldest = age(Some(oldest), screen.now).to_lowercase();
    if newest == oldest {
        format!("curves {newest} old")
    } else {
        format!("curves {newest} to {oldest} old")
    }
}

/// The active policy, what it is expected to produce, and the best hurdle the sweep offers
/// instead.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn VerdictPanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let overall = &screen.dashboard.overall;
    let active = overall
        .policy_comparisons
        .iter()
        .find(|c| c.role == Role::Active);
    let modeled = active.map_or(overall.current_policy_value, |a| a.summary.physical_value);
    let returns = screen.hurdle_returns();
    let (best, best_detail) = alternative(
        returns.first(),
        returns.iter().find(|r| r.scenario.configured),
        t,
    );
    let wait = active.and_then(|a| a.summary.estimated_time).map_or_else(
        || "Not modeled".to_owned(),
        |w| {
            format!(
                "{} / {} days",
                fixed(w.median_days, 1),
                fixed(w.p90_days, 1)
            )
        },
    );
    html! {
        <section class={panel()} aria-label="Active policy">
            <div class={Title}>
                <h2>{policy_label(screen)}</h2>
                <Chip mood={Mood::Good} label="Active" />
            </div>
            <p class={muted()}>
                "Modeled returns assume net proceeds are reinvested after the capital turnaround below; they are directional, not observed growth."
            </p>
            <div class={Stats}>
                <Stat
                    label="Modeled value"
                    value={&dollars(t, modeled)}
                    detail={&format!(
                        "{} against {} listed now",
                        delta_dollars(t, modeled - overall.current_listed_value),
                        dollars(t, overall.current_listed_value)
                    )}
                />
                <Stat
                    label="Expected wait"
                    value={&wait}
                    detail="Median / P90 until the next sale, weighted by units; not liquidation of every unit"
                />
                <Stat label="Best hurdle" value={&best} detail={&best_detail} />
                <Stat
                    label="Modeled coverage"
                    value={&coverage(overall.modeled_unit_count, overall.unit_count)}
                    detail={&format!(
                        "{} of {} SKUs \u{b7} {}",
                        count(t, overall.modeled_sku_count as i64),
                        count(t, overall.sku_count as i64),
                        curve_age(overall, screen)
                    )}
                />
            </div>
        </section>
    }
}

/// Listed value, median / P90 wait, and SKUs raised / lowered at each hurdle, for the inventory
/// and each product line; the configured hurdle's cell is shaded.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn HurdleSweep<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let lines: Vec<&ProductLine> = std::iter::once(&screen.dashboard.overall)
        .chain(&screen.dashboard.product_lines)
        .collect();
    let mut hurdles: Vec<f64> = lines
        .iter()
        .flat_map(|l| l.hurdle_sweep.iter().map(|s| s.daily_return_hurdle))
        .collect();
    hurdles.sort_by(f64::total_cmp);
    hurdles.dedup();
    html! {
        <section class={panel()} aria-labelledby="hurdle-sweep">
            <h2 id="hurdle-sweep">"Hurdle sweep"</h2>
            <p class={muted()}>
                "Listed value, median / P90 wait, and SKUs raised / lowered against current prices at each daily return hurdle. The shaded cell is the configured hurdle."
            </p>
            <div class={Scroll}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th>"Product line"</th>
                            for hurdle in &hurdles {
                                <th class={End}>{format_hurdle(*hurdle)}</th>
                            }
                        </tr>
                    </thead>
                    <tbody>
                        for line in &lines {
                            <tr key={&line.key}>
                                <th scope="row" class={(line.key == "all").then_some(Overall)}>
                                    {&line.product_line}
                                </th>
                                for hurdle in &hurdles {
                                    match line.hurdle_sweep.iter().find(|s| s.daily_return_hurdle == *hurdle) {
                                        Some(s) => {
                                            <td class={(End, s.configured.then_some(Configured))}>
                                                <span class={Value}>
                                                    {dollars(t, s.summary.physical_value)}
                                                </span>
                                                <small>
                                                    match s.summary.estimated_time {
                                                        Some(w) => {
                                                            {fixed(w.median_days, 1)}" / "
                                                            {fixed(w.p90_days, 1)}" days"
                                                        }
                                                        None => { "No wait estimate" }
                                                    }
                                                </small>
                                                <small>
                                                    "\u{2191} "
                                                    {count(t, s.summary.raised_count as i64)}
                                                    " \u{b7} \u{2193} "
                                                    {count(t, s.summary.lowered_count as i64)}
                                                </small>
                                            </td>
                                        }
                                        None => { <td class={End}>"\u{2014}"</td> }
                                    }
                                }
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        </section>
    }
}
