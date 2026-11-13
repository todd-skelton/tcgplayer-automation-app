use corten::{i18n::Currency, prelude::*};

use super::matrix_table::{ConditionNotes, Usd, cents};
use crate::{
    features::product_price_matrix::matrix::{self, Cell, Matrix, Refund},
    layout::Notice,
    text::{Msg, msg},
    ui::{
        alert::AlertVariant,
        control_width::{ControlWidth, Width},
        field::Field,
        input::Input,
        input_group::{Adornment, InputGroup},
        select::Select,
    },
};

// The dispute's controls, which the script reads; nothing posts them.
#[derive(Id)]
struct DisputeVariantId;
#[derive(Id)]
struct DisputeSoldId;
#[derive(Id)]
struct DisputeReceivedId;
#[derive(Id)]
struct DisputePaidId;

const USD: Currency = Currency::new("USD");

/// A dispute as the helper opens it, or as the operator set it: the variant, the condition sold
/// and the one received, and the price paid.
struct Dispute<'a> {
    variant: &'a str,
    conditions: Vec<&'a str>,
    sold: Option<&'a Cell>,
    received: Option<&'a Cell>,
    paid: Option<f64>,
}

impl<'a> Dispute<'a> {
    /// The first variant, its best condition sold and the next worse received, at the price the
    /// buyer most likely paid.
    fn opening(matrix: &'a Matrix) -> Self {
        let variant = matrix
            .variants
            .first()
            .map(String::as_str)
            .or_else(|| matrix.cells.first().map(|c| c.variant.as_str()))
            .unwrap_or("");
        let of_variant: Vec<&Cell> = matrix
            .cells
            .iter()
            .filter(|c| c.variant == variant)
            .collect();
        let conditions: Vec<&str> = of_variant.iter().map(|c| c.condition.as_str()).collect();
        let sold = of_variant.first().copied();
        let received = of_variant.get(1).or(of_variant.first()).copied();
        Dispute {
            variant,
            conditions,
            sold,
            received,
            paid: sold.and_then(Cell::likely_paid),
        }
    }

    fn same(&self) -> bool {
        matches!((self.sold, self.received), (Some(s), Some(r)) if s.condition == r.condition)
    }

    fn by_sell_at(&self) -> Option<Refund> {
        matrix::refund(self.paid, self.received.and_then(|c| c.ladder_price))
    }

    fn by_market(&self) -> Option<Refund> {
        matrix::refund(self.paid, self.received.and_then(|c| c.market_ladder_price))
    }
}

/// Dollars as a message writes them: "$3.20", or "N/A".
fn usd(t: Msg, value: Option<f64>) -> String {
    value.map_or_else(|| "N/A".to_owned(), |v| t.money(cents(v), USD).to_string())
}

/// "+$3.20", "-$1.10" or "$0.00": a difference in dollars (`formatSignedUsd`).
fn signed(t: Msg, value: f64) -> String {
    t.signed_money(cents(value), USD).to_string()
}

/// One condition's prices for the script: 0 is none.
#[component(view)]
pub fn PricedCondition<'a>(
    variant: &'a str,
    condition: &'a str,
    ladder: f64,
    market_ladder: f64,
    sell_at: f64,
    paid: &'a str,
    days: &'a str,
) -> impl Render {
    html! {
        <li
            data-variant={variant}
            data-condition={condition}
            data-ladder={ladder}
            data-market-ladder={market_ladder}
            data-sell-at={sell_at}
            data-paid={paid}
            data-days={days}
        ></li>
    }
}

/// Turns a condition dispute into a number: what the buyer paid, less what the received
/// condition would sell for. The sell-at ladder decides; the market ladder shows how far that
/// sits from TCGplayer's own view. The server draws the dispute the helper opens with; the
/// script draws it again as the operator changes it.
#[component(css, js)]
pub fn RefundHelper<'a>(matrix: &'a Matrix, t: Msg) -> impl Render {
    let d = Dispute::opening(matrix);
    let (variant, sold, received, paid, same, enter, unpriced, unpriced_line, results, refund) =
        refs();
    let (keeps, no_loss, sells, market, versus, no_market, relist, relist_note, notes, cells) =
        refs();
    let dispute = js::Dispute {
        variant,
        sold,
        received,
        paid,
        same,
        enter,
        unpriced,
        unpriced_line,
        results,
        refund,
        keeps,
        no_loss,
        sells,
        market,
        versus,
        no_market,
        relist,
        relist_note,
        notes,
        cells,
        unpriced_text: t.js().price_matrix_unpriced(),
        keeps_text: t.js().price_matrix_keeps(),
        no_loss_text: t.js().price_matrix_no_loss(),
        sells_text: t.js().price_matrix_sells(),
        versus_text: t.js().price_matrix_versus(),
        relist_text: t.js().price_matrix_relist(),
        relist_eta_text: t.js().price_matrix_relist_eta(),
        money: t.js().money(USD),
        signed_money: t.js().signed_money(USD),
        none: "N/A",
    };
    let sold_name = d.sold.map_or("", |c| c.condition.as_str());
    let received_name = d.received.map_or("", |c| c.condition.as_str());
    let by_sell_at = d.by_sell_at();
    let by_market = d.by_market();
    let shown = !d.same() && by_sell_at.is_some();
    let paid_text = d.paid.map(|p| format!("{p:.2}")).unwrap_or_default();
    let all_conditions = {
        let mut seen: Vec<&str> = Vec::new();
        for c in &matrix.cells {
            if !seen.contains(&c.condition.as_str()) {
                seen.push(&c.condition);
            }
        }
        seen
    };
    let received_cell = d.received;
    let modeled_days = received_cell.and_then(Cell::modeled_days);
    html! {
        <section
            class={RefundHelper}
            aria-labelledby="condition-dispute"
            on:change={js::changed(event, dispute)}
            on:input={js::typed(event, dispute)}
        >
            <h3 id="condition-dispute">"Condition dispute"</h3>
            <p class={Muted}>
                "The refund that leaves the buyer paying what the received condition would sell for."
            </p>
            <div class={Controls}>
                <div hidden={matrix.variants.len() <= 1}>
                    <Field id={DisputeVariantId} label="Variant" hint="" error="">
                        <select class={Select {}} id={DisputeVariantId} ref={variant}>
                            for v in &matrix.variants {
                                <option value={v} selected={v == d.variant}>{v}</option>
                            }
                        </select>
                    </Field>
                </div>
                <Field id={DisputeSoldId} label="Sold as" hint="" error="">
                    <select class={Select {}} id={DisputeSoldId} ref={sold}>
                        for c in &all_conditions {
                            <option
                                value={*c}
                                selected={*c == sold_name}
                                hidden={!d.conditions.contains(c)}
                            >
                                {*c}
                            </option>
                        }
                    </select>
                </Field>
                <Field id={DisputeReceivedId} label="Received as" hint="" error="">
                    <select class={Select {}} id={DisputeReceivedId} ref={received}>
                        for c in &all_conditions {
                            <option
                                value={*c}
                                selected={*c == received_name}
                                hidden={!d.conditions.contains(c)}
                            >
                                {*c}
                            </option>
                        }
                    </select>
                </Field>
                <Field id={DisputePaidId} label="Price paid (USD)" hint="" error="">
                    <span class={(InputGroup {}, ControlWidth { width: Width::Sm })}>
                        <Adornment>"$"</Adornment>
                        <input
                            class={Input {}}
                            id={DisputePaidId}
                            ref={paid}
                            value={&paid_text}
                            inputmode="decimal"
                        >
                    </span>
                </Field>
            </div>
            // The script shows one of these at a time; each is the kit's Alert in a box it hides.
            <div ref={same} hidden={!d.same()}>
                <Notice variant={AlertVariant::Info}>
                    <p>"Sold and received conditions match, so there is nothing to refund."</p>
                </Notice>
            </div>
            <div ref={enter} hidden={d.same() || d.paid.is_some()}>
                <Notice variant={AlertVariant::Warning}>
                    <p>"Enter the price the buyer paid."</p>
                </Notice>
            </div>
            <div
                ref={unpriced}
                hidden={d.same() || d.paid.is_none() || by_sell_at.is_some()}
            >
                <Notice variant={AlertVariant::Warning}>
                    <p ref={unpriced_line}>{t.price_matrix_unpriced(received_name)}</p>
                </Notice>
            </div>
            <div ref={results} class={Results} hidden={!shown}>
                <div>
                    <small class={Overline}>"Refund by what you would sell at"</small>
                    <strong ref={refund} class={Big}>
                        <Usd value={by_sell_at.as_ref().map(|r| r.refund)} t={t} />
                    </strong>
                    <p
                        ref={keeps}
                        class={Muted}
                        hidden={by_sell_at.as_ref().is_some_and(|r| r.refund == 0.0)}
                    >
                        {t.price_matrix_keeps(msg::PriceMatrixKeeps {
                            net: usd(t, by_sell_at.as_ref().map(|r| r.net)),
                            condition: received_name,
                        })}
                    </p>
                    <p
                        ref={no_loss}
                        class={Caution}
                        hidden={!by_sell_at.as_ref().is_some_and(|r| r.refund == 0.0)}
                    >
                        {t.price_matrix_no_loss(msg::PriceMatrixNoLoss { condition: received_name, paid: usd(t, d.paid) })}
                    </p>
                    <p ref={sells} class={Muted}>
                        {t.price_matrix_sells(msg::PriceMatrixSells {
                            received: received_name,
                            received_price: usd(t, received_cell.and_then(|c| c.ladder_price)),
                            sold_price: usd(t, d.sold.and_then(|c| c.ladder_price)),
                            sold: sold_name,
                        })}
                    </p>
                </div>
                <div>
                    <small class={Overline}>"Refund by market"</small>
                    <strong ref={market} class={Medium}>
                        <Usd value={by_market.as_ref().map(|r| r.refund)} t={t} />
                    </strong>
                    <p ref={versus} class={Muted} hidden={by_market.is_none()}>
                        {t.price_matrix_versus(msg::PriceMatrixVersus {
                            difference: signed(t, by_market.as_ref().map_or(0.0, |m| m.refund) - by_sell_at.as_ref().map_or(0.0, |r| r.refund)),
                            received: received_name,
                            received_price: usd(t, received_cell.and_then(|c| c.market_ladder_price)),
                            sold: sold_name,
                            sold_price: usd(t, d.sold.and_then(|c| c.market_ladder_price)),
                        })}
                    </p>
                    <p ref={no_market} class={Muted} hidden={by_market.is_some()}>
                        "One of the conditions has no market price."
                    </p>
                </div>
                <div>
                    <small class={Overline}>"If it comes back"</small>
                    <strong ref={relist} class={Medium}>
                        <Usd value={received_cell.and_then(|c| c.sell_at_price)} t={t} />
                    </strong>
                    <p ref={relist_note} class={Muted}>
                        match modeled_days {
                            Some(days) => {
                                {t.price_matrix_relist_eta(msg::PriceMatrixRelistEta { condition: received_name, days: matrix::days(Some(days)) })}
                            }
                            None => { {t.price_matrix_relist(received_name)} }
                        }
                    </p>
                    for c in &matrix.cells {
                        let key = format!("{}|{}", c.variant, c.condition);
                        <div
                            ref={notes}
                            key={key}
                            hidden={!received_cell.is_some_and(|r| std::ptr::eq(r, c))}
                        >
                            <ConditionNotes cell={c} errors={false} t={t} />
                        </div>
                    }
                </div>
            </div>
            <ul ref={cells} hidden>
                for c in &matrix.cells {
                    let paid = c.likely_paid().map(|p| format!("{p:.2}")).unwrap_or_default();
                    let days = c.modeled_days().map(|d| matrix::days(Some(d))).unwrap_or_default();
                    <PricedCondition
                        variant={&c.variant}
                        condition={&c.condition}
                        ladder={c.ladder_price.unwrap_or(0.0)}
                        market_ladder={c.market_ladder_price.unwrap_or(0.0)}
                        sell_at={c.sell_at_price.unwrap_or(0.0)}
                        paid={&paid}
                        days={&days}
                    />
                }
            </ul>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two conditions of one variant, priced, as suggested pricing draws them.
    fn priced() -> Matrix {
        serde_json::from_value(serde_json::json!({
            "variants": ["Normal"],
            "suggestedPricesIncluded": true,
            "pricedAt": "2026-11-03T00:00:00Z",
            "cells": [
                {"sku": 1, "condition": "Near Mint", "variant": "Normal", "language": "English",
                 "tcgMarketPrice": 10.0, "lowestSalePrice": null, "highestSalePrice": null,
                 "listing": null, "sellAtPrice": 10.0, "ladderPrice": 10.0, "marketLadderPrice": 10.0,
                 "estimatedTimeToSellDays": null, "pricingDecision": null,
                 "shadowPricingDecision": null, "conditionNormalization": null},
                {"sku": 2, "condition": "Lightly Played", "variant": "Normal", "language": "English",
                 "tcgMarketPrice": 8.0, "lowestSalePrice": null, "highestSalePrice": null,
                 "listing": null, "sellAtPrice": 8.0, "ladderPrice": 8.0, "marketLadderPrice": 8.0,
                 "estimatedTimeToSellDays": null, "pricingDecision": null,
                 "shadowPricingDecision": null, "conditionNormalization": null}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn each_control_is_a_kit_field_its_label_names() {
        let html = RefundHelper {
            matrix: &priced(),
            t: Msg::default(),
        }
        .to_html();
        for id in ["dispute-sold", "dispute-received", "dispute-paid"] {
            assert!(
                html.contains(&format!("for=\"{id}\"")),
                "{id} has no label: {html}"
            );
            assert!(
                html.contains(&format!("id=\"{id}\"")),
                "{id} has no control: {html}"
            );
        }
        // Near Mint sold, Lightly Played received, $10 paid: a $2 refund, no notice shown.
        assert!(html.contains("value=\"10.00\""), "{html}");
        assert!(html.contains("$2.00"), "{html}");
        assert_eq!(html.matches("alert__alert").count(), 3, "{html}");
    }

    #[test]
    fn a_difference_is_written_with_its_sign() {
        let t = Msg::default();
        assert_eq!(signed(t, 3.2), "+$3.20");
        assert_eq!(signed(t, -1.1), "-$1.10");
        assert_eq!(signed(t, 0.004), "$0.00");
    }
}
