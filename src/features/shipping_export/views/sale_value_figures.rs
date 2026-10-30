use corten::{
    i18n::{Currency, Decimal, Minor},
    prelude::*,
};

use crate::{
    features::shipping_export::value::{Comparison, SaleValue},
    text::Msg,
};

const USD: Currency = Currency::new("USD");

/// Dollars as the cents `t.money` writes.
pub fn cents(dollars: f64) -> Minor<i64> {
    Minor((dollars * 100.0).round() as i64)
}

/// A ratio (0.084) as `t.change` writes it, to a tenth of a percent: `+8.4%`.
fn change(ratio: f64) -> Decimal {
    Decimal::new((ratio * 1000.0).round() as i128, 3)
}

/// Above, below or at the reference, as the change reads to a tenth of a percent.
fn tone(ratio: Option<f64>) -> Option<Tone> {
    let tenths = (ratio? * 1000.0).round();
    Some(if tenths > 0.0 {
        Tone::Above
    } else if tenths < 0.0 {
        Tone::Below
    } else {
        Tone::At
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Above,
    Below,
    At,
}

/// What it sold for against a reference: the reference, then the difference and its change,
/// green above and red below. `-` when there is nothing to compare.
#[component(css = SaleValueFigures)]
fn Against<'a>(comparison: Option<&'a Comparison>, t: Msg) -> impl Render {
    html! {
        match comparison {
            None => "-",
            Some(c) => {
                let sign = if (c.difference * 100.0).round() > 0.0 { "+" } else if (c.difference * 100.0).round() < 0.0 { "-" } else { "" };
                {t.money(cents(c.total), USD)}" "
                <span
                    class={(Delta, (tone(c.ratio) == Some(Tone::Above)).then_some(Above), (tone(c.ratio) == Some(Tone::Below)).then_some(Below))}
                >
                    {sign}{t.money(cents(c.difference.abs()), USD)}
                    if let Some(ratio) = c.ratio { " "{t.change(change(ratio), 1)} }
                </span>
            }
        }
    }
}

/// A figure with a star and a note when it covers only part of the sale.
#[component(css = SaleValueFigures)]
fn Figure<'a>(label: &'a str, partial: Option<&'a str>, children: impl Render) -> impl Render {
    html! {
        <div title={partial.map(|p| format!("Partial: {p}. The comparison covers only those."))}>
            <dt>{label}</dt>
            <dd>
                {children}
                if partial.is_some() { "*" }
            </dd>
        </div>
    }
}

/// Price, current market, intake price and market, and age, for a card, an order, a shipment or
/// the batch. A difference is the price minus that value. `on_image` is for over a card's
/// picture, which needs lighter colors.
#[component(css)]
pub fn SaleValueFigures<'a>(value: &'a SaleValue, on_image: bool, t: Msg) -> impl Render {
    html! {
        <dl class={(SaleValueFigures, on_image.then_some(OnImage))}>
            <Figure label="Price" partial={None}>{t.money(cents(value.price), USD)}</Figure>
            <Figure
                label="Market"
                partial={value.market.as_ref().and_then(|m| m.partial.as_deref())}
            >
                <Against comparison={value.market.as_ref()} t={t} />
            </Figure>
            <Figure
                label="Intake"
                partial={value.intake.as_ref().and_then(|m| m.partial.as_deref())}
            >
                match &value.intake {
                    None => "-",
                    Some(intake) => {
                        <span class={Sub}>"Price"</span>{t.money(cents(intake.price), USD)}" "
                        <span class={Sub}>"Market"</span>
                        <Against comparison={Some(intake)} t={t} />
                    }
                }
            </Figure>
            <Figure label="Age" partial={value.age_partial.as_deref()}>
                match value.age_days {
                    None => "-",
                    Some(days) => { {t.number(Decimal::new((days * 10.0).round() as i128, 1))}"d" }
                }
            </Figure>
        </dl>
    }
}
