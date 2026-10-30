use chrono::{DateTime, Utc};
use corten::{
    i18n::{Currency, DateStyle, Decimal, Minor, TimeStyle},
    prelude::*,
};

use crate::{
    features::batch_pricer::{
        batches::{Summary, percent_from_market},
        page::SuccessRates,
    },
    layout::{Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

const USD: Currency = Currency::new("USD");

/// An amount the Node app sends as dollars, in cents.
fn cents(dollars: f64) -> Minor<i64> {
    Minor((dollars * 100.0).round() as i64)
}

/// A count the Node app sends as a JSON number.
fn whole(count: f64) -> i64 {
    count.round() as i64
}

/// A difference in percent (12.5), as the ratio `t.change` writes to a tenth of a percent.
fn ratio(percent: f64) -> Decimal {
    Decimal::new((percent * 10.0).round() as i128, 3)
}

/// What a batch's saved pricing results come to: its rows, quantities, product lines, price
/// totals against the market, and the percentiles, as the React screen's summary showed them.
#[component(css)]
pub fn BatchSummary<'a>(
    summary: &'a Summary,
    last_priced: Option<DateTime<Utc>>,
    rates: SuccessRates,
    t: Msg,
    visitor: Visitor,
) -> impl Render {
    let combined = summary.combined_quantity();
    let per_unit = move |total: f64| {
        if combined > 0.0 {
            total / combined
        } else {
            0.0
        }
    };
    // A difference from the market value is drawn above, below, or level.
    let direction = |p: Option<f64>| {
        let p = p.unwrap_or(0.0);
        ((p > 0.0).then_some(Above), (p < 0.0).then_some(Below))
    };
    let market = summary.totals_with_market.market_price;
    let low = summary.totals.low_price.unwrap_or(0.0);
    let marketplace = summary.totals.marketplace_price.unwrap_or(0.0);
    let low_change =
        percent_from_market(summary.totals_with_market.low_price.unwrap_or(0.0), market);
    let marketplace_change = percent_from_market(
        summary.totals_with_market.marketplace_price.unwrap_or(0.0),
        market,
    );
    let keys = summary.percentile_keys();
    let lines = summary
        .product_line_breakdown
        .as_ref()
        .filter(|l| !l.is_empty());
    html! {
        <section class={(panel(), BatchSummary)} aria-label="Batch summary">
            <h2>"Batch Summary"</h2>
            <p><strong>"Batch: "</strong>{&summary.file_name}</p>
            <p class={muted()}>"Current aggregate for the saved batch pricing results."</p>
            <p class={muted()}>
                "Last priced: "
                match last_priced {
                    Some(at) => {
                        {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    }
                    None => { "No prices produced" }
                }
            </p>
            <div class={Cards}>
                <div class={Card}>
                    <h3>"Record Statistics"</h3>
                    <table>
                        <tbody>
                            <tr>
                                <td>"Total Records"</td>
                                <td>{t.number(whole(summary.total_rows))}</td>
                            </tr>
                            <tr>
                                <td>"Successfully Priced"</td>
                                <td class={Above}>{t.number(whole(summary.processed_rows))}</td>
                            </tr>
                            <tr>
                                <td>"Manual Review / Errors"</td>
                                <td class={Caution}>
                                    {t.number(whole(summary.manual_review_rows))}
                                </td>
                            </tr>
                            <tr>
                                <td>"Skipped"</td>
                                <td>{t.number(whole(summary.skipped_rows))}</td>
                            </tr>
                            <tr>
                                <td>"Rows With Errors"</td>
                                <td class={Below}>{t.number(whole(summary.error_rows))}</td>
                            </tr>
                            <tr>
                                <td>"Rows With Warnings"</td>
                                <td class={Caution}>{t.number(whole(summary.warning_rows))}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class={Card}>
                    <h3>"Quantity Summary"</h3>
                    <table>
                        <tbody>
                            <tr>
                                <td>"Total Quantity"</td>
                                <td>{t.number(whole(summary.total_quantity))}</td>
                            </tr>
                            <tr>
                                <td>"Add to Quantity"</td>
                                <td>{t.number(whole(summary.total_add_quantity))}</td>
                            </tr>
                            <tr>
                                <td><strong>"Combined Total"</strong></td>
                                <td><strong>{t.number(whole(combined))}</strong></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            if let Some(lines) = lines {
                <div class={Card}>
                    <h3>"Product Line Breakdown"</h3>
                    <p class={muted()}>"Current successful rows grouped by product line."</p>
                    <table>
                        <thead>
                            <tr>
                                <th>"Product Line"</th>
                                <th>"Items"</th>
                                <th>"Percentiles Used"</th>
                                <th>"Total Value"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (name, line) in lines {
                                <tr>
                                    <td>{name}</td>
                                    <td>{t.number(whole(line.count))}</td>
                                    <td>{line.percentiles()}</td>
                                    <td>{t.money(cents(line.total_value), USD)}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
            <div class={Card}>
                <h3>"Price Totals (Weighted by Quantity)"</h3>
                <table>
                    <thead>
                        <tr>
                            <th>"Price Type"</th>
                            <th>"Total Value"</th>
                            <th>"Average per Unit"</th>
                            <th>"% vs Market"</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>"Market Price"</td>
                            <td>{t.money(cents(summary.totals.market_price), USD)}</td>
                            <td>{t.money(cents(per_unit(summary.totals.market_price)), USD)}</td>
                            <td>{t.change(ratio(0.0), 1)}</td>
                        </tr>
                        <tr>
                            <td>"Low Price"</td>
                            <td>{t.money(cents(low), USD)}</td>
                            <td>{t.money(cents(per_unit(low)), USD)}</td>
                            <td class={direction(low_change)}>
                                match low_change {
                                    Some(p) => { {t.change(ratio(p), 1)} }
                                    None => { "Not available" }
                                }
                            </td>
                        </tr>
                        <tr>
                            <td><strong>"Marketplace Price"</strong></td>
                            <td><strong>{t.money(cents(marketplace), USD)}</strong></td>
                            <td><strong>{t.money(cents(per_unit(marketplace)), USD)}</strong></td>
                            <td class={direction(marketplace_change)}>
                                <strong>
                                    match marketplace_change {
                                        Some(p) => { {t.change(ratio(p), 1)} }
                                        None => { "Not available" }
                                    }
                                </strong>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            if !keys.is_empty() {
                <div class={Card}>
                    <h3>"Percentile Analysis"</h3>
                    <p class={muted()}>
                        "Rebuilt from the saved pricing details on successful rows."
                    </p>
                    <table>
                        <thead>
                            <tr>
                                <th>"Percentile"</th>
                                <th>"Total Value"</th>
                                <th>"% Difference from Market"</th>
                                <th>"Historical Sales Velocity"</th>
                                <th>"Estimated Time to Sell"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for key in &keys {
                                <PercentileRow summary={summary} key={key} t={t} />
                            }
                        </tbody>
                    </table>
                </div>
            }
            <div class={row(Space::_2)}>
                <span class={(Chip, Above)}>
                    {t.number(whole(summary.processed_rows))}" successful"
                </span>
                <span class={(Chip, Caution)}>
                    {t.number(whole(summary.manual_review_rows))}" manual review"
                </span>
                if summary.skipped_rows > 0.0 {
                    <span class={Chip}>
                        {t.number(whole(summary.skipped_rows))}" not yet priced"
                    </span>
                }
                if summary.warning_rows > 0.0 {
                    <span class={(Chip, Caution)}>
                        {t.number(whole(summary.warning_rows))}" rows with warnings"
                    </span>
                }
            </div>
            if summary.success_rate < rates.low {
                <Notice tone={Tone::Warning}>
                    "The batch still has a low success rate. Repricing remaining manual review rows may improve the final batch output."
                </Notice>
            }
            if summary.success_rate >= rates.high {
                <Notice tone={Tone::Done}>
                    "The batch is in good shape with "{format!("{:.1}", summary.success_rate)}
                    "% of rows currently priced successfully."
                </Notice>
            }
        </section>
    }
}

/// A percentile's total, how far it is from the market value, and how long it takes to sell.
#[component(css = BatchSummary)]
fn PercentileRow<'a>(summary: &'a Summary, key: &'a str, t: Msg) -> impl Render {
    let total = summary.totals.percentiles.get(key).copied().unwrap_or(0.0);
    let with_market = summary
        .totals_with_market
        .percentiles
        .get(key)
        .copied()
        .unwrap_or(0.0);
    let change =
        percent_from_market(with_market, summary.totals_with_market.market_price).unwrap_or(0.0);
    let direction = (
        (change > 0.0).then_some(Above),
        (change < 0.0).then_some(Below),
    );
    let days = summary.median_days_to_sell.percentiles.get(key);
    let adjusted = summary
        .median_days_to_sell
        .market_adjusted_percentiles
        .as_ref()
        .and_then(|p| p.get(key));
    html! {
        <tr>
            <td>{key}</td>
            <td>{t.money(cents(total), USD)}</td>
            <td class={direction}>{t.change(ratio(change), 1)}</td>
            <td>
                match days {
                    Some(d) => { {format!("{d:.1} days")} }
                    None => { "N/A" }
                }
            </td>
            <td>
                match adjusted {
                    Some(d) => { {format!("{d:.1} days")} }
                    None => { "Not available" }
                }
            </td>
        </tr>
    }
}
