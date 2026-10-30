use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::{Choice as Option_, ComboBox, Picker};

use super::{MatrixTable, RefundHelper};
use crate::{
    features::{
        inventory_intake::catalog::{ProductType, Scope},
        product_price_matrix::{
            page::Screen,
            url::{self, Choice},
        },
    },
    layout::{Notice, SubmitsOnChange, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The screen: the choices that find a product, then its prices by condition and variant, and
/// once the policy priced it, the condition dispute helper.
#[component(css)]
pub fn MatrixScreen<'a>(screen: &'a Screen, visitor: Visitor, t: Msg) -> impl Render {
    let f = Choice::FIELDS;
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
                            <span class={Chip}>
                                "Priced "
                                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                            </span>
                        }
                        if m.suggested_prices_included {
                            <span class={(Chip, Good)}>"Suggested prices included"</span>
                        } else {
                            <span class={Chip}>"Market prices only"</span>
                        }
                    </div>
                }
            </header>
            <form
                method="get"
                action={url::ProductPriceMatrix { choice: Choice::default() }}
                class={(panel(), Choices)}
                aria-label="Choose a product"
                data-keep-place
            >
                <SubmitsOnChange>
                    <div class={Line}>
                        <label>
                            "Product Line"
                            <select name={f.line}>
                                for l in &screen.lines {
                                    <option value={l.id} selected={l.id == screen.line}>
                                        {&l.name}
                                    </option>
                                }
                            </select>
                        </label>
                        <label>
                            "Product Type"
                            <select name={f.product_type}>
                                for (value, text) in [(ProductType::All, "All Products"), (ProductType::UnsealedOnly, "Unsealed Only"), (ProductType::SealedOnly, "Sealed Only")] {
                                    <option value={value} selected={screen.product_type == value}>
                                        {text}
                                    </option>
                                }
                            </select>
                        </label>
                        <label class={Toggle}>
                            <input
                                type="checkbox"
                                name={f.scope}
                                value={Scope::AllSets}
                                checked={screen.scope == Scope::AllSets}
                            >
                            "All sets"
                        </label>
                    </div>
                    <div class={Line}>
                        if screen.scope == Scope::Set {
                            <label class={Wide}>
                                "Set"
                                <select name={f.set}>
                                    for s in &screen.sets {
                                        <option value={s.id} selected={Some(s.id) == screen.set}>
                                            {s.label()}
                                        </option>
                                    }
                                </select>
                            </label>
                        } else {
                            if let Some(set) = screen.set {
                                <input type="hidden" name={f.set} value={set}>
                            }
                            <label class={Wide}>
                                "Card Number"
                                <input name={f.number} value={&screen.number} inputmode="search">
                            </label>
                        }
                        <div class={(Wide, Picked)}>
                            <label for="product">"Product"</label>
                            <ProductPicker screen={screen} />
                        </div>
                        <label>
                            "Language"
                            <select name={f.language} disabled={screen.product.is_none()}>
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
                        if let Some(p) = &screen.product {
                            <input type="hidden" name={f.shown_product} value={p.product_id}>
                        }
                        <button class={Button}>
                            if screen.scope == Scope::AllSets { "Search" } else { "Show" }
                        </button>
                    </div>
                </SubmitsOnChange>
            </form>
            if let Err(why) = &screen.products {
                <Notice tone={Tone::Warning}>"Failed to load products: "{why}</Notice>
            }
            if none_found {
                <Notice tone={Tone::Info}>"No matching products found."</Notice>
            }
            if let Some(product) = &screen.product {
                <section class={(panel(), Product)} aria-label={&product.product_name}>
                    <header class={Head}>
                        <div>
                            <h2>{&product.product_name}</h2>
                            <div class={row(Space::_2)}>
                                if let Some(number) = product.card_number.as_deref().filter(|n| !n.is_empty()) {
                                    <span class={Chip}>"#"{number}</span>
                                }
                                <span class={Chip}>{&product.set_name}</span>
                                if let Some(rarity) = product.rarity_name.as_deref().filter(|r| !r.is_empty()) {
                                    <span class={Chip}>{rarity}</span>
                                }
                                <span class={Chip}>{product.sku_count}" SKUs"</span>
                                <span class={Chip}>
                                    {screen.language.as_deref().unwrap_or("No language")}
                                </span>
                                if let Some(policy) = matrix.and_then(|m| m.policy.as_ref()) {
                                    <span class={(Chip, Policy)}>{policy.describe()}</span>
                                }
                            </div>
                        </div>
                        // The runtime marks the link busy until the priced page arrives.
                        <div class={(row(Space::_2), Reads)}>
                            <a href={screen.market()} class={Button}>"↻ Refresh Market"</a>
                            <a href={screen.suggested()} class={(Button, Primary)}>
                                "Suggested Pricing"
                            </a>
                        </div>
                    </header>
                    match &screen.matrix {
                        Some(Err(why)) => {
                            <Notice tone={Tone::Warning}>"Failed to load prices: "{why}</Notice>
                        }
                        Some(Ok(m)) => {
                            if m.cells.is_empty() {
                                <Notice tone={Tone::Info}>
                                    "No SKUs are available for the selected language."
                                </Notice>
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
