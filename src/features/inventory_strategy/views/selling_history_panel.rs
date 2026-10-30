use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use super::{
    format::{count, days, fixed, instant, words},
    strategy_screen::{Chip, Mood, Stat},
};
use crate::{
    features::inventory_strategy::{
        screen::Screen,
        selling_history::{
            OrderCoverage, PercentileStatus, Ready, Report, Scope, SellThroughStatus, Summary,
            UnavailableReason, WINDOWS,
        },
        url::{self, View},
    },
    layout::{Notice, SubmitsOnChange, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// "1 unit", "1,234 units".
fn units(t: Msg, n: i64) -> String {
    format!("{} {}", count(t, n), if n == 1 { "unit" } else { "units" })
}

fn reason_words(reason: UnavailableReason) -> &'static str {
    match reason {
        UnavailableReason::SellerNotConfigured => "seller not configured",
        UnavailableReason::InventoryCoverageMissing => "inventory coverage missing",
        UnavailableReason::OrderCoverageIncomplete => "order coverage incomplete",
        UnavailableReason::HistoryBoundsExceeded => "history bounds exceeded",
    }
}

fn percentile_words(status: PercentileStatus) -> &'static str {
    match status {
        PercentileStatus::Estimable => "estimable",
        PercentileStatus::NotReached => "not reached",
        PercentileStatus::CompetingRemovals => "competing removals",
        PercentileStatus::UnsettledOutcomes => "unsettled outcomes",
        PercentileStatus::UncertainPresence => "uncertain presence",
    }
}

/// A time in the visitor's zone, or "Unknown".
#[component]
fn When<'a>(at: Option<&'a str>, t: Msg, visitor: Visitor) -> impl Render {
    html! {
        match at.and_then(instant) {
            Some(at) => { {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)} }
            None => { "Unknown" }
        }
    }
}

/// Observed listing exposure and sales outcomes for the current seller.
#[component(css = super::strategy_screen::StrategyScreen)]
pub fn SellingHistoryPanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let visitor = screen.visitor;
    html! {
        <section class={panel()} aria-labelledby="selling-history">
            match &screen.selling_history {
                Err(why) => {
                    <h2 id="selling-history">"Selling history"</h2>
                    <Notice tone={Tone::Warning}>{*why}</Notice>
                }
                Ok(Report::Unavailable(report)) => {
                    <h2 id="selling-history">"Selling history"</h2>
                    <ScopeControls scope={&report.scope} lines={&report.available_product_lines} />
                    <p class={muted()}>
                        "Selling history is unavailable: "{reason_words(report.reason)}"."
                    </p>
                    <div>
                        <Chip
                            mood={Mood::Caution}
                            label={&format!("Order history: {}", words(&report.order_coverage.status))}
                        />
                    </div>
                }
                Ok(Report::Ready(report)) => {
                    <div class={Title}>
                        <h2 id="selling-history">"Selling history"</h2>
                        <Chip mood={Mood::Good} label="Observed listing exposure" />
                    </div>
                    <ScopeControls scope={&report.scope} lines={&report.available_product_lines} />
                    <p class={muted()}>
                        "Analysis from "
                        <When at={Some(&report.analysis_from)} t={t} visitor={visitor} />
                        " \u{b7} As of "
                        <When at={Some(&report.as_of)} t={t} visitor={visitor} />
                        ". Time listed is separate from intake-to-sale age."
                    </p>
                    if report.overall.cohort_quantity == 0 {
                        <p class={muted()}>
                            "No published listing cohorts are available in this analysis window yet."
                        </p>
                    } else {
                        <HistorySummary summary={&report.overall} t={t} />
                        <SellThroughTable summary={&report.overall} t={t} />
                        <LineTable report={report} t={t} />
                    }
                    <CoverageNote report={report} t={t} visitor={visitor} />
                }
            }
        </section>
    }
}

/// The window and product line the history covers, read again as either changes.
#[component(css = super::strategy_screen::StrategyScreen)]
fn ScopeControls<'a>(scope: &'a Scope, lines: &'a [String]) -> impl Render {
    let f = View::FIELDS;
    let line = scope.product_line.as_deref().unwrap_or("");
    html! {
        <form method="get" action={url::InventoryStrategy { view: View::default() }}>
            <SubmitsOnChange>
                <div class={Line}>
                    <label class={Choice}>
                        <span>"History window"</span>
                        <select name={f.history_days}>
                            for days in WINDOWS {
                                <option value={days} selected={days == scope.window_days}>
                                    "Last "{days}" days"
                                </option>
                            }
                        </select>
                    </label>
                    <label class={Choice}>
                        <span>"Product line"</span>
                        <select name={f.history_product_line}>
                            <option value="" selected={line.is_empty()}>"All product lines"</option>
                            for name in lines {
                                <option value={name} selected={name == line}>{name}</option>
                            }
                        </select>
                    </label>
                    <noscript><button>"Show"</button></noscript>
                </div>
            </SubmitsOnChange>
        </form>
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn HistorySummary<'a>(summary: &'a Summary, t: Msg) -> impl Render {
    let remaining =
        (summary.cohort_quantity - summary.sold_quantity - summary.removed_quantity).max(0);
    let known = summary.remaining_with_known_age_quantity
        + summary.remaining_with_uncertain_presence_quantity;
    let unknown = (remaining - known).max(0);
    let none = "Unavailable";
    html! {
        <div class={Stats}>
            <Stat
                label="Sold"
                value={&units(t, summary.sold_quantity)}
                detail={&format!("{} with a known listed date", units(t, summary.sold_with_known_listed_date_quantity))}
            />
            <Stat
                label="Sold-only average"
                value={&days(summary.sold_only_average_days, none)}
                detail="Observed time listed before sale; it is not an expected wait for all inventory"
            />
            <Stat
                label="Median / P90"
                value={&format!(
                    "{} / {}",
                    days(summary.median_days_to_sale, none),
                    days(summary.p90_days_to_sale, none)
                )}
                detail={&match summary.percentile_status {
                    PercentileStatus::Estimable => "Time listed before sale".to_owned(),
                    other => format!("Unavailable: {}", percentile_words(other)),
                }}
            />
            <Stat
                label="Ledger expected remaining"
                value={&units(t, remaining)}
                detail={&format!(
                    "{} with known age \u{b7} {} uncertain presence \u{b7} {} unknown listed date",
                    units(t, summary.remaining_with_known_age_quantity),
                    units(t, summary.remaining_with_uncertain_presence_quantity),
                    units(t, unknown)
                )}
            />
        </div>
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn SellThroughTable<'a>(summary: &'a Summary, t: Msg) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table} aria-label="Age-eligible sell-through">
                <thead>
                    <tr>
                        <th>"Age-eligible sell-through"</th>
                        <th class={End}>"Eligible"</th>
                        <th class={End}>"Sold"</th>
                        <th class={End}>"Rate"</th>
                    </tr>
                </thead>
                <tbody>
                    for horizon in &summary.sell_through {
                        <tr key={horizon.days}>
                            <th scope="row">{horizon.days}" days"</th>
                            <td class={End}>{units(t, horizon.eligible_quantity)}</td>
                            <td class={End}>{units(t, horizon.sold_quantity)}</td>
                            <td class={End}>
                                match (horizon.rate, horizon.status) {
                                    (Some(rate), _) => { {fixed(rate * 100.0, 1)}"%" }
                                    (None, SellThroughStatus::UnsettledOutcomes) => {
                                        "Unavailable: unsettled outcomes"
                                    }
                                    (None, _) => { "Unavailable" }
                                }
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
    }
}

#[component(css = super::strategy_screen::StrategyScreen)]
fn LineTable<'a>(report: &'a Ready, t: Msg) -> impl Render {
    html! {
        if !report.product_lines.is_empty() {
            <div class={Scroll}>
                <table class={Table} aria-label="Product-line selling history">
                    <thead>
                        <tr>
                            <th>"Product line"</th>
                            <th class={End}>"Cohort"</th>
                            <th class={End}>"Sold"</th>
                            <th class={End}>"Sold-only average"</th>
                            <th class={End}>"Remaining known age"</th>
                        </tr>
                    </thead>
                    <tbody>
                        for line in &report.product_lines {
                            <tr key={&line.product_line}>
                                <th scope="row">{&line.product_line}</th>
                                <td class={End}>{units(t, line.summary.cohort_quantity)}</td>
                                <td class={End}>{units(t, line.summary.sold_quantity)}</td>
                                <td class={End}>
                                    {days(line.summary.sold_only_average_days, "Unavailable")}
                                </td>
                                <td class={End}>
                                    {units(t, line.summary.remaining_with_known_age_quantity)}
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        }
    }
}

/// How far the order history reaches, and what it is missing.
#[component(css = super::strategy_screen::StrategyScreen)]
fn CoverageNote<'a>(report: &'a Ready, t: Msg, visitor: Visitor) -> impl Render {
    let OrderCoverage {
        status,
        observed_through,
        gaps,
        error,
        ..
    } = &report.order_coverage;
    let o = &report.overall;
    let gaps: Vec<&str> = gaps
        .iter()
        .map(String::as_str)
        .filter(|g| !g.is_empty())
        .collect();
    html! {
        <p class={(muted(), Caption)}>
            "Order history "{words(status)}
            if let Some(through) = observed_through {
                " through "
                <When at={Some(through)} t={t} visitor={visitor} />
            }
            {format!(
                " \u{b7} {} of {} with a known listed date",
                units(t, o.known_listed_date_quantity),
                units(t, o.cohort_quantity)
            )}
            if o.unknown_listed_date_quantity > 0 {
                {format!(
                    " \u{b7} {} with an unknown listed date are excluded from timing",
                    units(t, o.unknown_listed_date_quantity)
                )}
            }
        </p>
        if !gaps.is_empty() || error.is_some() {
            <p class={(Caption, Warn)}>
                if !gaps.is_empty() {
                    "History gaps: "{gaps.join("; ")}
                }
                if !gaps.is_empty() && error.is_some() {
                    " \u{b7} "
                }
                if let Some(error) = error {
                    "Last sync issue: "{error}
                }
            </p>
        }
    }
}
