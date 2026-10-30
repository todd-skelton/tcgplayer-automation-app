use corten::{
    i18n::{Currency, Decimal, Minor},
    prelude::*,
};

use crate::{
    features::product_price_matrix::matrix::{self, Cell, Decision, Matrix},
    text::Msg,
};

const USD: Currency = Currency::new("USD");

/// Dollars as the cents `t.money` writes.
pub fn cents(dollars: f64) -> Minor<i64> {
    Minor((dollars * 100.0).round() as i64)
}

/// Each condition of each variant: TCGplayer's market and sales, the store's listing, what the
/// policy would sell at against market, the percentile policy's price beside it when it differs,
/// and what stood in for missing data. The variant, condition and market stay in view while the
/// rest scrolls.
#[component(css)]
pub fn MatrixTable<'a>(matrix: &'a Matrix, t: Msg) -> impl Render {
    let shadow = matrix
        .cells
        .iter()
        .find_map(|c| c.shadow_pricing_decision.as_ref())
        .map(|d| d.method);
    let cells = &matrix.cells;
    html! {
        <div class={Scroll}>
            <table class={MatrixTable} aria-label="Product prices by condition and variant">
                <thead>
                    <tr>
                        <th class={(Sticky, VariantColumn)}>"Variant"</th>
                        <th class={(Sticky, ConditionColumn)}>"Condition"</th>
                        <th class={(Sticky, MarketColumn, End)}>"Market"</th>
                        <th class={End}>"Low"</th>
                        <th class={End}>"High"</th>
                        <th class={End}>"Sales"</th>
                        if matrix.listings_included {
                            <th class={End}>"Your listing"</th>
                        }
                        <th class={(End, SellAt)}>"Sell at"</th>
                        <th class={End}>"vs market"</th>
                        if let Some(method) = shadow {
                            <th class={End}>{method.label()}</th>
                        }
                        <th>"Notes"</th>
                    </tr>
                </thead>
                <tbody>
                    for (i, cell) in cells.iter().enumerate() {
                        // The tint the condition's row carries, as the React table colored it: none for Near Mint.
                        let tint = match cell.condition.as_str() { "Lightly Played" => Some(Lp), "Moderately Played" => Some(Mp), "Heavily Played" => Some(Hp), "Damaged" => Some(Dmg), _ => None };
                        <tr
                            class={(tint, (i == 0 || cells[i - 1].variant != cell.variant).then_some(Starts))}
                        >
                            <th scope="row" class={(Sticky, VariantColumn)}>{&cell.variant}</th>
                            <td class={(Sticky, ConditionColumn)}>
                                <span class={ConditionChip}>{&cell.condition}</span>
                            </td>
                            <td class={(Sticky, MarketColumn, End)}>
                                <strong><Usd value={cell.tcg_market_price} t={t} /></strong>
                            </td>
                            <td class={End}><Usd value={cell.lowest_sale_price} t={t} /></td>
                            <td class={End}><Usd value={cell.highest_sale_price} t={t} /></td>
                            <td class={End}>{t.number(cell.sale_count)}</td>
                            if matrix.listings_included {
                                <td class={End}><Listed cell={cell} t={t} /></td>
                            }
                            <td
                                class={(End, SellAt, cell.sell_at_price.is_some().then_some(Priced))}
                            >
                                <SellAtPrice
                                    cell={cell}
                                    priced={matrix.suggested_prices_included}
                                    t={t}
                                />
                            </td>
                            <td class={End}>
                                <AgainstMarket
                                    price={cell.sell_at_price}
                                    market={cell.tcg_market_price}
                                    t={t}
                                />
                            </td>
                            if shadow.is_some() {
                                <td class={End}>
                                    <Shadow
                                        decision={cell.shadow_pricing_decision.as_ref()}
                                        t={t}
                                    />
                                </td>
                            }
                            <td><ConditionNotes cell={cell} errors={true} t={t} /></td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
    }
}

/// Dollars, or "N/A" without any.
#[component(css = MatrixTable)]
pub fn Usd(value: Option<f64>, t: Msg) -> impl Render {
    html! {
        match value {
            Some(v) => { {t.money(cents(v), USD)} }
            None => { "N/A" }
        }
    }
}

#[component(css = MatrixTable)]
fn Listed<'a>(cell: &'a Cell, t: Msg) -> impl Render {
    html! {
        match &cell.listing {
            None => <span class={Muted}>"Not listed"</span>,
            Some(l) => {
                <strong><Usd value={l.price} t={t} /></strong>
                <small>
                    if l.in_stock && l.quantity > 0 {
                        {t.number(l.quantity)}" in stock"
                    } else {
                        "Out of stock"
                    }
                </small>
            }
        }
    }
}

/// What the store would list at, how long it should take to sell (or where the price came
/// from), and the rule and anything that held it.
#[component(css = MatrixTable)]
fn SellAtPrice<'a>(cell: &'a Cell, priced: bool, t: Msg) -> impl Render {
    html! {
        match (cell.sell_at_price, &cell.pricing_decision) {
            (Some(price), Some(d)) => {
                <strong><Usd value={Some(price)} t={t} /></strong>
                <small>
                    if d.modeled() {
                        {matrix::days(cell.estimated_time_to_sell_days)}
                        if let Some(p) = d.equivalent_percentile { " · ≈"{matrix::ordinal(p)} }
                    } else {
                        {d.basis()}
                    }
                </small>
                <small>
                    {d.rule()}
                    if d.constraint != "none" { " · "{d.constraint.replace('-', " ")} }
                    if d.unprofitable { " · below overhead" }
                </small>
            }
            _ => {
                <span class={Muted}>
                    if !cell.errors.is_empty() {
                        "Failed"
                    } else if priced {
                        "No price"
                    } else {
                        "Not priced"
                    }
                </span>
            }
        }
    }
}

/// The sell-at price against market, to a tenth of a percent: green above, red below.
#[component(css = MatrixTable)]
fn AgainstMarket(price: Option<f64>, market: Option<f64>, t: Msg) -> impl Render {
    let ratio = price
        .zip(market.filter(|m| *m > 0.0))
        .map(|(p, m)| (p - m) / m);
    html! {
        match ratio {
            None => <span class={Muted}>"—"</span>,
            Some(r) => {
                let tenths = (r * 1000.0).round();
                <span
                    class={(Chip, (tenths > 0.0).then_some(Above), (tenths < 0.0).then_some(Below))}
                    title="Sell-at versus market"
                >
                    {t.change(Decimal::new(tenths as i128, 3), 1)}
                </span>
            }
        }
    }
}

/// The percentile policy's price beside the active one's.
#[component(css = MatrixTable)]
fn Shadow<'a>(decision: Option<&'a Decision>, t: Msg) -> impl Render {
    html! {
        match decision {
            None => <span class={Muted}>"—"</span>,
            Some(d) => {
                <span><Usd value={Some(d.selected_price)} t={t} /></span>
                <small>
                    if d.modeled() {
                        {matrix::days(d.estimated_median_sell_days)}
                    } else {
                        {d.basis()}
                    }
                    " · "{d.rule()}
                </small>
            }
        }
    }
}

/// What stood in for the condition's own market data, and the pricing's warnings and errors
/// (`ConditionNotes`): the table and the refund helper read the same caveats the same way.
#[component(css = MatrixTable)]
pub fn ConditionNotes<'a>(cell: &'a Cell, errors: bool, t: Msg) -> impl Render {
    let normalization = cell.condition_normalization.as_ref();
    let anchor = normalization.and_then(|n| n.anchor_condition.as_deref());
    html! {
        <span class={Notes}>
            if cell.tcg_market_price.is_none() {
                <span class={Chip}>"No market"</span>
            }
            if let Some(anchor) = anchor {
                <span
                    class={Chip}
                    title={format!("No market price for {}, so it is valued as {anchor} until its own sales say otherwise.", cell.condition)}
                >
                    "Valued as "{anchor}
                </span>
            }
            if normalization.is_some_and(|n| n.method == "neutral-condition-fallback") {
                <span
                    class={(Chip, Warn)}
                    title="No sales or market price for this or any sibling condition, so it is priced from the other conditions without a condition discount. Treat the sell-at price as an upper bound."
                >
                    "No condition data"
                </span>
            }
            if cell.above_better_condition {
                let ladder = cell.ladder_price.map(|p| t.money(cents(p), USD).to_string()).unwrap_or_else(|| "N/A".into());
                <span
                    class={(Chip, Warn)}
                    title={format!("The model priced this condition above a better one; refunds use {ladder} instead.")}
                >
                    "Above a better condition"
                </span>
            }
            if errors && !cell.warnings.is_empty() {
                <span class={(Chip, Warn, Filled)} title={cell.warnings.join(" ")}>"Warning"</span>
            }
            if errors && !cell.errors.is_empty() {
                <span class={(Chip, Bad, Filled)} title={cell.errors.join(" ")}>"Error"</span>
            }
        </span>
    }
}
