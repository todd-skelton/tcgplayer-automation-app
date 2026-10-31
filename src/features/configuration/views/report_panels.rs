//! The two report panels. The page draws each waiting inside a `<corten-live>` whose stream
//! sends it read, so the settings never wait for a report; its window is a GET form to its
//! report route, which answers the panel (the page without scripts).
//!
//! They share the configuration screen's stylesheet.
use chrono::DateTime;
use corten::prelude::*;

use crate::layout::SubmitsOnChange;
use crate::{
    features::{
        configuration::{config::EVIDENCE_WINDOWS, reports::Window, url},
        forecast_calibration::{
            Calibration, DEFAULT_WINDOW_DAYS, HeldOutCheck, TimeInStock, WINDOW_DAYS,
        },
        shipping_thresholds::{TierBasis, outcomes::SaleGroup, report::ShippingReport},
    },
    layout::{Notice, Tone},
    theme::*,
};

#[derive(Id)]
pub struct CalibrationId;
#[derive(Id)]
pub struct ShippingReportId;

/// A report as the panel has it: still to be read (a `<corten-live>` or a `ReadAgain` beside it
/// sends it read), or read.
pub enum Report<'a, T> {
    Waiting,
    Read(&'a Result<T, String>),
}

/// A report as the page draws it: sent by its `<corten-live>` stream once read, or already read
/// over a window (the report's route, reached without scripts).
pub enum OnPage<'a, T> {
    Streamed,
    Read(u32, &'a Result<T, String>),
}

/// Both reports as the page draws them.
pub struct Reports<'a> {
    pub calibration: OnPage<'a, Calibration>,
    pub shipping: OnPage<'a, ShippingReport>,
    /// The shipping report's window until another is chosen: the snaps' evidence window.
    pub evidence_days: u32,
    /// The daily return hurdle the calibration weighs, under the profit-per-day policy.
    pub hurdle: Option<f64>,
}

/// The shipping report, then the calibration. Each panel is its own section, patched on its own.
#[component(css = super::configuration_screen::ConfigurationScreen)]
pub fn ReportPanels<'a>(reports: &'a Reports<'a>) -> impl Render {
    html! {
        match reports.shipping {
            OnPage::Read(days, report) => <ShippingReportPanel days={days} report={Report::Read(report)} />,
            OnPage::Streamed => {
                <corten-live src={url::ShippingReportLive}>
                    <ShippingReportPanel days={reports.evidence_days} report={Report::Waiting} />
                </corten-live>
            }
        }
        match reports.calibration {
            OnPage::Read(days, report) => <CalibrationPanel days={days} report={Report::Read(report)} hurdle={reports.hurdle} />,
            OnPage::Streamed => {
                <corten-live src={url::CalibrationLive}>
                    <CalibrationPanel
                        days={DEFAULT_WINDOW_DAYS}
                        report={Report::Waiting}
                        hurdle={reports.hurdle}
                    />
                </corten-live>
            }
        }
    }
}

fn money(value: f64) -> String {
    format!("${value:.2}")
}

fn share(value: Option<f64>) -> String {
    value.map_or_else(|| "N/A".into(), |v| format!("{}%", (v * 100.0).round()))
}

/// A number with thousands separators and at most three decimals, as `toLocaleString` writes it
/// in English: 1,220 and 3.83.
fn count(value: f64) -> String {
    let rounded = format!("{:.3}", value.abs());
    let (digits, fraction) = rounded.split_once('.').unwrap_or((&rounded, ""));
    let fraction = fraction.trim_end_matches('0');
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if !fraction.is_empty() {
        out = format!("{out}.{fraction}");
    }
    if value < 0.0 && out.chars().any(|c| c.is_ascii_digit() && c != '0') {
        format!("-{out}")
    } else {
        out
    }
}

fn maybe_count(value: Option<f64>) -> String {
    value.map_or_else(|| "N/A".into(), count)
}

/// A report's date as `toLocaleDateString` writes it in English: 10/4/2026.
fn date(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map_or_else(|_| value.to_owned(), |d| d.format("%-m/%-d/%Y").to_string())
}

/// A window select that reads the panel again when it changes; a Show button without scripts.
#[component(css = super::configuration_screen::ConfigurationScreen)]
fn WindowChoice<'a>(days: u32, windows: &'a [u32], label: &'a str) -> impl Render {
    let f = Window::FIELDS;
    html! {
        <SubmitsOnChange>
            <label class={WindowSelect}>
                {label}
                <select name={f.days}>
                    for window in windows {
                        <option value={*window} selected={*window == days}>
                            "Last "{*window}" days"
                        </option>
                    }
                </select>
                <noscript><button>"Show"</button></noscript>
            </label>
        </SubmitsOnChange>
    }
}

#[component(css = super::configuration_screen::ConfigurationScreen)]
pub fn CalibrationPanel<'a>(
    days: u32,
    report: Report<'a, Calibration>,
    hurdle: Option<f64>,
) -> impl Patch {
    let at = url::CalibrationReport {
        window: Window { days: Some(days) },
    };
    html! {
        <section
            id={CalibrationId}
            class={(panel(), ReportSection)}
            aria-labelledby={CalibrationHeadingId}
        >
            <h2 id={CalibrationHeadingId}>"Sell-Time Forecast Calibration"</h2>
            <p class={muted()}>
                "How the store's own listings sold against the days to sell the pricing curve forecast for them. Every published price is followed while it was in stock, until it was replaced or sold out, and each order counts as one sale. Actual days per forecast day above 1 means listings sold slower than forecast; it is measured over the earlier three quarters of the window and checked on the latest quarter. This is a report only: pricing uses the forecasts as they are, and the report shows how far off they run so the daily return hurdle can account for it."
            </p>
            <form
                method="get"
                action={url::CalibrationReport { window: Window::default() }}
                data-patch
            >
                <WindowChoice days={days} windows={&WINDOW_DAYS} label="Measure over " />
            </form>
            match report {
                Report::Waiting => <p class={muted()} role="status">
                    "Measuring… "<a href={&at}>"Show the report"</a>
                </p>,
                Report::Read(Err(error)) => <Notice tone={Tone::Warning}>{error}</Notice>,
                Report::Read(Ok(r)) => {
                    let whole = r.earlier.plus(&r.held_out);
                    <Notice
                        tone={if r.held_out_check == HeldOutCheck::Confirmed { Tone::Info } else { Tone::Warning }}
                    >
                        "Listings sold at "
                        {format!("{:.0}", 100.0 / r.actual_days_per_forecast_day)}
                        "% of the forecast rate, taking "
                        {format!("{:.2}", r.actual_days_per_forecast_day)}
                        " actual days per forecast day. "
                        match r.held_out_check {
                            HeldOutCheck::Confirmed => "The earlier weeks' rate held up on the held-out weeks.",
                            HeldOutCheck::NotConfirmed => "Not confirmed: the earlier weeks' rate did not forecast the held-out weeks better.",
                            HeldOutCheck::TooFewSales => "Not confirmed: too few sales to check against held-out weeks.",
                        }
                        match hurdle {
                            Some(h) => {
                                " The "{format!("{:.2}%", h * 100.0)}
                                " daily return hurdle applies over forecast days, so it asks "
                                {format!("{:.2}%", h / r.actual_days_per_forecast_day * 100.0)}
                                " per day listings actually take. To ask a given return per actual day, set the hurdle to that return times "
                                {format!("{:.2}", r.actual_days_per_forecast_day)}"."
                            }
                            None => {}
                        }
                    </Notice>
                    <h3>
                        "Measured from "{date(&r.from)}" through "{date(&r.through)}
                        ", holding out prices listed from "{date(&r.held_out_from)}
                    </h3>
                    <table class={Figures}>
                        <thead>
                            <tr>
                                <th>"Listed"</th>
                                <th>"Prices"</th>
                                <th>"Days in stock"</th>
                                <th>"Sales seen"</th>
                                <th>"Sales forecast"</th>
                                <th>"Actual days per forecast day"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (label, time) in [("Earlier", &r.earlier), ("Held out", &r.held_out), ("Whole window", &whole)] {
                                <TimeRow label={label} time={time} />
                            }
                        </tbody>
                    </table>
                }
            }
        </section>
    }
}

#[derive(Id)]
struct CalibrationHeadingId;
#[derive(Id)]
struct ShippingHeadingId;

#[component]
fn TimeRow<'a>(label: &'a str, time: &'a TimeInStock) -> impl Render {
    html! {
        <tr>
            <td>{label}</td>
            <td>{count(time.listings)}</td>
            <td>{format!("{:.0}", time.in_stock_days)}</td>
            <td>{count(time.sales)}</td>
            <td>{format!("{:.1}", time.forecast_sales)}</td>
            <td>{format!("{:.2}", time.actual_days_per_forecast_day())}</td>
        </tr>
    }
}

#[component]
fn SaleGroupRow<'a>(label: &'a str, group: &'a SaleGroup) -> impl Render {
    html! {
        <tr>
            <td>{label}</td>
            <td>{count(group.units as f64)}</td>
            <td>{count(group.orders as f64)}</td>
            <td>{maybe_count(group.median_days_to_sell)}</td>
            <td>{maybe_count(group.units_per_order)}</td>
            <td>{share(group.orders_with_add_ons)}</td>
            <td>{share(group.orders_reaching_threshold)}</td>
            <td>{count(group.largest_order_units as f64)}</td>
            <td>{share(group.bulk_order_unit_share)}</td>
            <td>{group.shipping_cost_per_order.map_or_else(|| "N/A".into(), money)}</td>
        </tr>
    }
}

/// What shipping costs at each threshold, learned from recent orders, and what snapping did over
/// the chosen window. A snaps save reads it again.
#[component(css = super::configuration_screen::ConfigurationScreen)]
pub fn ShippingReportPanel<'a>(days: u32, report: Report<'a, ShippingReport>) -> impl Patch {
    let at = url::ShippingReport {
        window: Window { days: Some(days) },
    };
    html! {
        <section
            id={ShippingReportId}
            class={(panel(), ReportSection)}
            aria-labelledby={ShippingHeadingId}
        >
            <h2 id={ShippingHeadingId}>"Shipping costs and snap outcomes"</h2>
            <form
                method="get"
                action={url::ShippingReport { window: Window::default() }}
                data-patch
            >
                <WindowChoice
                    days={days}
                    windows={&EVIDENCE_WINDOWS}
                    label="What snapping has done over "
                />
            </form>
            <p class={muted()}>
                "Bulk is three or more of the group's units in one order, the sign of a buyer sweeping snapped prices. Add-ons are orders with anything else. Reaching the threshold is how often other items carried a snapped order over it anyway. Shipping cost is postage less buyer shipping after fees, per order."
            </p>
            match report {
                Report::Waiting => <p class={muted()} role="status">
                    "Learning shipping costs… "<a href={&at}>"Show the report"</a>
                </p>,
                Report::Read(Err(error)) => <Notice tone={Tone::Warning}>{error}</Notice>,
                Report::Read(Ok(r)) => {
                    <h3>
                        "Learned from "{count(r.cost_model.order_count as f64)}" orders and "
                        {count(r.cost_model.basket_count as f64)}
                        " units sold in the last "{r.cost_model.evidence_window_days}" days"
                    </h3>
                    <table class={Figures}>
                        <thead>
                            <tr>
                                <th>"Order value"</th>
                                <th>"Orders"</th>
                                <th>"Buyer shipping"</th>
                                <th>"Postage"</th>
                                <th>"Basis"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for tier in &r.cost_model.tiers {
                                <tr>
                                    <td>"From "{money(tier.from_order_value)}</td>
                                    <td>{count(tier.order_count as f64)}</td>
                                    <td>{money(tier.buyer_shipping)}</td>
                                    <td>{money(tier.postage)}</td>
                                    <td>
                                        match tier.basis {
                                            TierBasis::Observed => "Observed",
                                            TierBasis::Default => "Default (too few orders)",
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                    <table class={Figures}>
                        <thead>
                            <tr>
                                <th>"Threshold"</th>
                                <th>"Units sold nearby"</th>
                                <th>"Shipping cost per unit one cent under"</th>
                                <th>"Shipping cost per unit at threshold"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for cost in &r.threshold_costs {
                                <tr>
                                    <td>{money(cost.threshold)}</td>
                                    <td>{count(cost.basket_count as f64)}</td>
                                    <td>
                                        {cost.snap_price_shipping_cost.map_or_else(|| "Too few sales to snap".into(), money)}
                                    </td>
                                    <td>
                                        {cost.threshold_shipping_cost.map_or_else(|| "Too few sales to snap".into(), money)}
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                    for outcome in &r.outcomes {
                        <p>
                            {money(outcome.threshold)}": "{outcome.listings.snapped}
                            " SKUs snapped to "{money(outcome.snap_price)}", "
                            {outcome.listings.kept}" kept above, "{outcome.listings.floor}
                            " held by the price floor"
                        </p>
                        <table class={Figures}>
                            <thead>
                                <tr>
                                    <th>"Sales"</th>
                                    <th>"Units"</th>
                                    <th>"Orders"</th>
                                    <th>"Median days to sell"</th>
                                    <th>"Units per order"</th>
                                    <th>"With add-ons"</th>
                                    <th>"Reached threshold"</th>
                                    <th>"Most in one order"</th>
                                    <th>"Bought in bulk"</th>
                                    <th>"Shipping cost per order"</th>
                                </tr>
                            </thead>
                            <tbody>
                                <SaleGroupRow label="Snapped" group={&outcome.snapped} />
                                <SaleGroupRow label="Kept above" group={&outcome.kept} />
                                <SaleGroupRow
                                    label="All sales just above"
                                    group={&outcome.just_above}
                                />
                            </tbody>
                        </table>
                    }
                }
            }
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_dates_read_as_the_react_app_wrote_them() {
        assert_eq!(count(1220.0), "1,220");
        assert_eq!(count(999.0), "999");
        assert_eq!(count(1_234_567.0), "1,234,567");
        assert_eq!(count(3.83), "3.83");
        assert_eq!(count(2.0 / 3.0), "0.667");
        assert_eq!(date("2026-10-04T15:27:37.440Z"), "10/4/2026");
        assert_eq!(share(Some(0.507)), "51%");
    }
}
