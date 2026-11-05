use corten::{
    i18n::{Currency, Decimal, Minor},
    prelude::*,
};

use crate::{
    features::product_price_matrix::matrix::{self, Cell, Decision, Matrix},
    text::Msg,
    ui::{
        badge::{Badge, BadgeEmphasis, BadgeTone},
        popover::Popover,
        table::TableNumeric,
    },
};

/// A caveat's reason, by a key naming its list (the table or the refund helper), SKU and kind.
#[derive(Id)]
struct CaveatId<'a>(&'a str);

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
                        <th class={(Sticky, MarketColumn, TableNumeric {})}>"Market"</th>
                        <th class={TableNumeric {}}>"Low"</th>
                        <th class={TableNumeric {}}>"High"</th>
                        <th class={TableNumeric {}}>"Sales"</th>
                        if matrix.listings_included {
                            <th class={TableNumeric {}}>"Your listing"</th>
                        }
                        <th class={(TableNumeric {}, SellAt)}>"Sell at"</th>
                        <th class={TableNumeric {}}>"vs market"</th>
                        if let Some(method) = shadow {
                            <th class={TableNumeric {}}>{method.label()}</th>
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
                            <td class={(Sticky, MarketColumn, TableNumeric {})}>
                                <strong><Usd value={cell.tcg_market_price} t={t} /></strong>
                            </td>
                            <td class={TableNumeric {}}>
                                <Usd value={cell.lowest_sale_price} t={t} />
                            </td>
                            <td class={TableNumeric {}}>
                                <Usd value={cell.highest_sale_price} t={t} />
                            </td>
                            <td class={TableNumeric {}}>{t.number(cell.sale_count)}</td>
                            if matrix.listings_included {
                                <td class={TableNumeric {}}><Listed cell={cell} t={t} /></td>
                            }
                            <td
                                class={(TableNumeric {}, SellAt, cell.sell_at_price.is_some().then_some(Priced))}
                            >
                                <SellAtPrice
                                    cell={cell}
                                    priced={matrix.suggested_prices_included}
                                    t={t}
                                />
                            </td>
                            <td class={TableNumeric {}}>
                                <AgainstMarket
                                    price={cell.sell_at_price}
                                    market={cell.tcg_market_price}
                                    t={t}
                                />
                            </td>
                            if shadow.is_some() {
                                <td class={TableNumeric {}}>
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
                let tone = if tenths > 0.0 {
                    BadgeTone::Success
                } else if tenths < 0.0 {
                    BadgeTone::Destructive
                } else {
                    BadgeTone::Neutral
                };
                <span
                    class={Badge { tone, emphasis: BadgeEmphasis::Outline }}
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
    let key = |kind: &str| {
        format!(
            "{}-{}-{kind}",
            if errors { "table" } else { "refund" },
            cell.sku
        )
    };
    html! {
        <span class={Notes}>
            if cell.tcg_market_price.is_none() {
                <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                    "No market"
                </span>
            }
            if let Some(anchor) = anchor {
                <Caveat
                    key={&key("valued-as")}
                    tone={BadgeTone::Neutral}
                    emphasis={BadgeEmphasis::Outline}
                    label={&format!("Valued as {anchor}")}
                    reason={&format!("No market price for {}, so it is valued as {anchor} until its own sales say otherwise.", cell.condition)}
                />
            }
            if normalization.is_some_and(|n| n.method == "neutral-condition-fallback") {
                <Caveat
                    key={&key("no-condition-data")}
                    tone={BadgeTone::Warning}
                    emphasis={BadgeEmphasis::Outline}
                    label="No condition data"
                    reason="No sales or market price for this or any sibling condition, so it is priced from the other conditions without a condition discount. Treat the sell-at price as an upper bound."
                />
            }
            if cell.above_better_condition {
                let ladder = cell.ladder_price.map(|p| t.money(cents(p), USD).to_string()).unwrap_or_else(|| "N/A".into());
                <Caveat
                    key={&key("above-better")}
                    tone={BadgeTone::Warning}
                    emphasis={BadgeEmphasis::Outline}
                    label="Above a better condition"
                    reason={&format!("The model priced this condition above a better one; refunds use {ladder} instead.")}
                />
            }
            if errors && !cell.warnings.is_empty() {
                <Caveat
                    key={&key("warning")}
                    tone={BadgeTone::Warning}
                    emphasis={BadgeEmphasis::Soft}
                    label="Warning"
                    reason={&cell.warnings.join(" ")}
                />
            }
            if errors && !cell.errors.is_empty() {
                <Caveat
                    key={&key("error")}
                    tone={BadgeTone::Destructive}
                    emphasis={BadgeEmphasis::Soft}
                    label="Error"
                    reason={&cell.errors.join(" ")}
                />
            }
        </span>
    }
}

/// A caveat as a badge that opens its reason beside it. The reason decides whether the price can
/// be trusted, so a click or a tap shows it (a popover), not a pointer resting on the badge.
#[component(css = MatrixTable)]
fn Caveat<'a>(
    key: &'a str,
    tone: BadgeTone,
    emphasis: BadgeEmphasis,
    label: &'a str,
    reason: &'a str,
) -> impl Render {
    html! {
        <button
            type="button"
            class={(Badge { tone, emphasis }, CaveatButton)}
            popovertarget={CaveatId(key)}
        >
            {label}
        </button>
        <span id={CaveatId(key)} popover class={(Popover {}, CaveatReason)}>{reason}</span>
    }
}
