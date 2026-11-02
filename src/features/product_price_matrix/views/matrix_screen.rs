use chrono::{DateTime, Utc};
use corten::{
    form::keep_query,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::{Choice as Option_, ComboBox, Picker};

use super::{MatrixTable, RefundHelper};
use crate::{
    features::{
        inventory_intake::catalog::{ProductType, Scope},
        product_price_matrix::{page::Screen, url::Choice},
    },
    layout::SubmitsOnChange,
    text::Msg,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        input::Input,
        panel::Panel,
        select::Select,
        switch::Switch,
    },
};

/// The screen: the choices that find a product, then its prices by condition and variant, and
/// once the policy priced it, the condition dispute helper.
#[component(css)]
pub fn MatrixScreen<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let f = Choice::FIELDS;
    // The form keeps what it has no control for: the set while searching by number, and the
    // product it was drawn for.
    let here = screen.market();
    let matrix = screen.matrix.as_ref().and_then(|m| m.as_ref().ok());
    let priced_at = matrix.and_then(|m| m.priced_at.parse::<DateTime<Utc>>().ok());
    let none_found = screen.scope == Scope::AllSets
        && !screen.number.is_empty()
        && screen.products.as_ref().is_ok_and(Vec::is_empty);
    html! {
        <div class={MatrixScreen}>
            <header class={Head}>
                <div>
                    <h1>"Product Price Matrix"</h1>
                    <p class={muted()}>"Compare one product across conditions and variants."</p>
                </div>
                if let Some(m) = matrix {
                    <div class={row(Space::_2)}>
                        if let Some(at) = priced_at {
                            <span
                                class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                            >
                                "Priced "
                                {t.date_time(at, DateStyle::Short, TimeStyle::Medium)}
                            </span>
                        }
                        if m.suggested_prices_included {
                            <span
                                class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Soft }}
                            >
                                "Suggested prices included"
                            </span>
                        } else {
                            <span
                                class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                            >
                                "Market prices only"
                            </span>
                        }
                    </div>
                }
            </header>
            <form
                method="get"
                action={&here}
                class={(Panel {}, Choices)}
                aria-label="Choose a product"
                data-keep-place
            >
                {keep_query(&here, html! {
                <SubmitsOnChange>
                    <div class={Line}>
                        <label>
                            "Product Line"
                            <select class={Select {}} name={f.line}>
                                for l in &screen.lines {
                                    <option value={l.id} selected={l.id == screen.line}>
                                        {&l.name}
                                    </option>
                                }
                            </select>
                        </label>
                        <label>
                            "Product Type"
                            <select class={Select {}} name={f.product_type}>
                                for (value, text) in [(ProductType::All, "All Products"), (ProductType::UnsealedOnly, "Unsealed Only"), (ProductType::SealedOnly, "Sealed Only")] {
                                    <option value={value} selected={screen.product_type == value}>
                                        {text}
                                    </option>
                                }
                            </select>
                        </label>
                        <Switch label="All sets">
                            <input
                                type="checkbox"
                                role="switch"
                                name={f.scope}
                                value={Scope::AllSets}
                                checked={screen.scope == Scope::AllSets}
                            >
                        </Switch>
                    </div>
                    <div class={Line}>
                        if screen.scope == Scope::Set {
                            <label class={Wide}>
                                "Set"
                                <select class={Select {}} name={f.set}>
                                    for s in &screen.sets {
                                        <option value={s.id} selected={Some(s.id) == screen.set}>
                                            {s.label()}
                                        </option>
                                    }
                                </select>
                            </label>
                        } else {
                            <label class={Wide}>
                                "Card Number"
                                <input class={Input {}} name={f.number} value={&screen.number} inputmode="search">
                            </label>
                        }
                        <div class={(Wide, Picked)}>
                            <label for="product">"Product"</label>
                            <ProductPicker screen={screen} />
                        </div>
                        <label>
                            "Language"
                            <select class={Select {}} name={f.language} disabled={screen.product.is_none()}>
                                if let Some(p) = &screen.product {
                                    for language in &p.languages {
                                        <option
                                            value={language}
                                            selected={screen.language.as_ref() == Some(language)}
                                        >
                                            {language}
                                        </option>
                                    }
                                }
                            </select>
                        </label>
                        <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>
                            if screen.scope == Scope::AllSets { "Search" } else { "Show" }
                        </button>
                    </div>
                </SubmitsOnChange>
                })}
            </form>
            if let Err(why) = &screen.products {
                <Alert variant={AlertVariant::Warning}>"Failed to load products: "{why}</Alert>
            }
            if none_found {
                <Alert variant={AlertVariant::Info}>"No matching products found."</Alert>
            }
            if let Some(product) = &screen.product {
                <section
                    class={(Panel {}, Product)}
                    aria-label={&product.product_name}
                >
                    <header class={Head}>
                        <div>
                            <h2>{&product.product_name}</h2>
                            <div class={row(Space::_2)}>
                                if let Some(number) = product.card_number.as_deref().filter(|n| !n.is_empty()) {
                                    <span
                                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                                    >
                                        "#"{number}
                                    </span>
                                }
                                <span
                                    class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                                >
                                    {&product.set_name}
                                </span>
                                if let Some(rarity) = product.rarity_name.as_deref().filter(|r| !r.is_empty()) {
                                    <span
                                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                                    >
                                        {rarity}
                                    </span>
                                }
                                <span
                                    class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                                >
                                    {product.sku_count}" SKUs"
                                </span>
                                <span
                                    class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                                >
                                    {screen.language.as_deref().unwrap_or("No language")}
                                </span>
                                if let Some(policy) = matrix.and_then(|m| m.policy.as_ref()) {
                                    <span
                                        class={Badge { tone: BadgeTone::Primary, emphasis: BadgeEmphasis::Outline }}
                                    >
                                        {policy.describe()}
                                    </span>
                                }
                            </div>
                        </div>
                        // The runtime marks the link busy until the priced page arrives.
                        <div class={(row(Space::_2), Reads)}>
                            <a
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                                href={screen.market()}
                            >
                                "↻ Refresh Market"
                            </a>
                            <a
                                class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                                href={screen.suggested()}
                            >
                                "Suggested Pricing"
                            </a>
                        </div>
                    </header>
                    match &screen.matrix {
                        Some(Err(why)) => {
                            <Alert variant={AlertVariant::Warning}>
                                "Failed to load prices: "{why}
                            </Alert>
                        }
                        Some(Ok(m)) => {
                            if m.cells.is_empty() {
                                <Alert variant={AlertVariant::Info}>
                                    "No SKUs are available for the selected language."
                                </Alert>
                            } else {
                                <MatrixTable matrix={m} t={t} />
                                if m.suggested_prices_included {
                                    <RefundHelper matrix={m} t={t} />
                                }
                            }
                        }
                        None => {}
                    }
                </section>
            }
        </div>
    }
}

/// The products to choose from: type to narrow them, then pick one.
#[component(css = MatrixScreen)]
fn ProductPicker<'a>(screen: &'a Screen) -> impl Render {
    let f = Choice::FIELDS;
    html! {
        let options: Vec<Option_<i32, String>> = screen.choices.iter().map(|c| Option_::new(c.id, &c.label).terms(&c.terms)).collect();
        let picker = Picker { value: screen.chosen, disabled: options.is_empty(), ..Picker::new("product", f.product, "Choose a product", "No matching products", &options) };
        <ComboBox field={&picker} />
    }
}
