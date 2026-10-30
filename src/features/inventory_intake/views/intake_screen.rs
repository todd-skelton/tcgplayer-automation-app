use std::{collections::HashSet, time::Duration};

use corten::prelude::*;

use super::{background_batches::BackgroundBatches, queue_bar::QueueBar};
use crate::{
    features::inventory_intake::{
        catalog::{Condition, LANGUAGES, Product, ProductType, Scope},
        page::{CountInput, CountsKey, Screen},
        queue::{self, Batches, QueueInput},
        url::{self, Selection},
    },
    layout::{Notice, Tone},
    theme::*,
};

#[derive(Id)]
struct FiltersId;
#[derive(Id)]
struct ConditionSelectId;
#[derive(Id)]
struct SetSelectId;
#[derive(Id)]
struct SearchId;
#[derive(Id)]
struct TableHeadingId;
#[derive(Id)]
pub struct IntakeErrorId;
#[derive(Id)]
pub struct QueueNoticeId;
#[derive(Id)]
struct PictureId;
/// A SKU's count field, `quantity-{sku}`: a count's answer replaces it.
#[derive(Id)]
struct QuantityId(i32);

/// A SKU's count field: which SKU, where it belongs, and what it is called.
pub struct Counted<'a> {
    pub sku: i32,
    pub product: i32,
    pub set: i32,
    pub line: i32,
    pub label: &'a str,
}

impl<'a> From<&'a CountInput> for Counted<'a> {
    fn from(input: &'a CountInput) -> Self {
        Counted {
            sku: input.sku,
            product: input.product,
            set: input.set,
            line: input.line,
            label: &input.label,
        }
    }
}

/// How often the background batches are read again, as the React screen polled them.
pub const BATCHES_EVERY: Duration = Duration::from_secs(5);

/// What the screen shows of queuing: the background batches (or why they could not be read),
/// the queue form as it stands, and what the last queue did.
pub struct Queuing<'a> {
    pub batches: Result<&'a Batches, &'a str>,
    pub input: &'a QueueInput,
    pub errors: &'a Errors,
    pub notice: Option<&'a str>,
}

/// The screen: the filters, every product of the set with a count per condition, and the bar
/// that queues what is counted. CSS shows the counts of the condition chosen.
#[component(css, js)]
pub fn IntakeScreen<'a>(
    screen: &'a Screen,
    error: Option<&'a str>,
    queuing: &'a Queuing<'a>,
) -> impl Render {
    let (filters, conditions, sets, search, rows, dialog, image) = refs();
    let (form, sku, product, set, line, label, change, quantity, seen, request) = refs();
    let count = js::Count {
        form,
        sku,
        product,
        set,
        line,
        label,
        change,
        quantity,
        seen,
        request,
    };
    let keys = js::Keys {
        filters,
        conditions,
        sets,
        search,
        rows,
    };
    let f = Selection::FIELDS;
    let c = CountInput::FIELDS;
    let selection = &screen.selection;
    let searched = selection
        .search
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    html! {
        <section
            class={IntakeScreen}
            on:keydown={js::keys(event, keys, count)}
            on:focusin={js::focused(event)}
            on:input={js::typed(event)}
        >
            <header class={row(Space::_3)}>
                <h1>"Inventory Manager"</h1>
                <BackgroundBatches selection={selection} batches={queuing.batches} refused={None} />
                {ReadAgain { after: BATCHES_EVERY }.from(&url::Batches { selection: selection.clone() })}
            </header>
            <QueueNotice message={queuing.notice} />
            <IntakeError message={error} />
            <form
                id={FiltersId}
                ref={filters}
                method="get"
                action={url::InventoryManager { selection: Selection::default(), queued: None }}
                class={(panel(), Filters)}
                aria-label="Filters"
                on:change={js::filtered(event, keys)}
            >
                <label>
                    "Product Line"
                    <select name={f.line}>
                        for l in &screen.lines {
                            <option value={l.id} selected={l.id == screen.line}>{&l.name}</option>
                        }
                    </select>
                </label>
                <label>
                    "Set"
                    <select
                        id={SetSelectId}
                        ref={sets}
                        name={f.set}
                        disabled={screen.scope == Scope::AllSets}
                    >
                        for s in &screen.sets {
                            <option value={s.id} selected={Some(s.id) == screen.set}>
                                {s.label()}
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
                <label>
                    "Condition"
                    <select
                        id={ConditionSelectId}
                        ref={conditions}
                        name={f.condition}
                        class={ConditionSelect}
                    >
                        for c in Condition::ALL {
                            <option value={c} selected={c == screen.condition}>{c.name()}</option>
                        }
                    </select>
                </label>
                <details class={More}>
                    <summary>{more_filters(selection)}</summary>
                    <label>
                        "Product Type"
                        <select name={f.product_type}>
                            for (value, text) in [(ProductType::All, "All Products"), (ProductType::SealedOnly, "Sealed Only"), (ProductType::UnsealedOnly, "Unsealed Only")] {
                                <option
                                    value={value}
                                    selected={selection.product_type.unwrap_or_default() == value}
                                >
                                    {text}
                                </option>
                            }
                        </select>
                    </label>
                    <fieldset class={Languages}>
                        <legend>"Languages (none chosen: all)"</legend>
                        for language in LANGUAGES {
                            <label class={Toggle}>
                                <input
                                    type="checkbox"
                                    name={f.language}
                                    value={language}
                                    checked={selection.language.iter().any(|l| l == language)}
                                >
                                {language}
                            </label>
                        }
                    </fieldset>
                </details>
                <label class={SearchField}>
                    match screen.scope {
                        Scope::Set => "Search this set by name or number",
                        Scope::AllSets => "Card number, in every set",
                    }
                    <span class={row(Space::_2)}>
                        <input
                            id={SearchId}
                            ref={search}
                            type="search"
                            name={f.search}
                            value={selection.search.as_deref().unwrap_or("")}
                            autocomplete="off"
                        >
                        <button>"Search"</button>
                    </span>
                </label>
                <noscript><button>"Show"</button></noscript>
            </form>
            <form
                method="post"
                action={url::SaveCounts { selection: selection.clone() }}
                class={panel()}
                aria-labelledby={TableHeadingId}
            >
                {SubmitKey::field(CountsKey::FIELDS.submit)}
                <h2 id={TableHeadingId} class={VisuallyHidden}>"Add new inventory"</h2>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th>"Image"</th>
                            <th>"Set"</th>
                            <th>"SKU"</th>
                            <th>"Quantity"</th>
                            <th>"Product Name"</th>
                        </tr>
                    </thead>
                    <tbody
                        ref={rows}
                        on:click={js::clicked(event, count, js::Picture { dialog, image, search })}
                        on:change={js::committed(event, count)}
                        on:connect={js::start(rows, searched)}
                    >
                        for p in &screen.products {
                            <ProductRow product={p} screen={screen} />
                        }
                    </tbody>
                </table>
                if screen.products.is_empty() {
                    <p class={muted()}>
                        match screen.scope {
                            Scope::AllSets if !searched => "Enter a card number to search every set.",
                            _ => "No products match.",
                        }
                    </p>
                } else {
                    <noscript><button>"Save counts"</button></noscript>
                }
            </form>
            <form
                ref={form}
                method="post"
                action={url::Count { selection: selection.clone() }}
                hidden
            >
                <input ref={sku} name={c.sku}>
                <input ref={product} name={c.product}>
                <input ref={set} name={c.set}>
                <input ref={line} name={c.line}>
                <input ref={label} name={c.label}>
                <input ref={change} name={c.change}>
                <input ref={quantity} name={c.quantity}>
                <input ref={seen} name={c.seen}>
                <input ref={request} name={c.request}>
            </form>
            <QueueBar
                selection={selection}
                totals={screen.totals}
                counted={&queue::fingerprint(&screen.quantities)}
                input={queuing.input}
                target={queuing.batches.ok().map(|b| &b.target)}
                errors={queuing.errors}
            />
            <dialog id={PictureId} ref={dialog} class={Picture} closedby="any">
                <img ref={image} alt="Product">
                <form method="dialog"><button>"Close"</button></form>
            </dialog>
        </section>
    }
}

/// "More filters: Unsealed only, English": the summary says what the hidden filters do.
fn more_filters(selection: &Selection) -> String {
    let sealed = match selection.product_type.unwrap_or_default() {
        ProductType::All => None,
        ProductType::SealedOnly => Some("Sealed only".to_owned()),
        ProductType::UnsealedOnly => Some("Unsealed only".to_owned()),
    };
    let languages = match selection.language.len() {
        0 => None,
        1 | 2 => Some(selection.language.join(", ")),
        n => Some(format!("{n} languages")),
    };
    let parts: Vec<String> = [sealed, languages].into_iter().flatten().collect();
    if parts.is_empty() {
        "More filters".into()
    } else {
        format!("More filters: {}", parts.join(", "))
    }
}

/// TCGplayer's picture of a product.
fn picture(product_id: i32) -> String {
    format!("https://tcgplayer-cdn.tcgplayer.com/product/{product_id}_in_400x400.jpg")
}

/// A product's row. The table's click handler opens its picture and steps its count.
#[component(css = IntakeScreen)]
fn ProductRow<'a>(product: &'a Product, screen: &'a Screen) -> impl Render {
    let set = match &product.release_year {
        Some(year) => format!("{} - {year}", product.set_name),
        None => product.set_name.clone(),
    };
    html! {
        <tr>
            <td>
                <a href={picture(product.product_id)} tabindex="-1">"View"</a>
            </td>
            <td><span class={Chip}>{set}</span></td>
            <td>
                if product.sealed {
                    <SkuLabel product={product} condition={None} />
                } else {
                    for c in Condition::ALL {
                        <SkuLabel product={product} condition={Some(c)} />
                    }
                }
            </td>
            <td>
                if product.sealed {
                    <QuantityCell product={product} condition={None} screen={screen} />
                } else {
                    for c in Condition::ALL {
                        <QuantityCell product={product} condition={Some(c)} screen={screen} />
                    }
                }
            </td>
            <td class={Name}>{&product.display_name}</td>
        </tr>
    }
}

/// `Lightly Played Reverse Holofoil`, or `Lightly Played unavailable`.
#[component(css = IntakeScreen)]
fn SkuLabel<'a>(product: &'a Product, condition: Option<Condition>) -> impl Render {
    // Shown only while its condition is chosen; a sealed product's always.
    let shown = condition.map(|c| match c {
        Condition::NearMint => NearMint,
        Condition::LightlyPlayed => LightlyPlayed,
        Condition::ModeratelyPlayed => ModeratelyPlayed,
        Condition::HeavilyPlayed => HeavilyPlayed,
        Condition::Damaged => Damaged,
    });
    let name = condition.map_or("Unopened", Condition::name);
    let sku = condition.map_or(product.unopened, |c| product.sku(c));
    let variant = (product.variant != "Normal").then_some(product.variant.as_str());
    let holo = variant
        .is_some_and(|v| v.to_lowercase().contains("reverse") || v.to_lowercase().contains("holo"));
    let first = variant
        .is_some_and(|v| v.to_lowercase().contains("1st") || v.to_lowercase().contains("first"));
    html! {
        <span
            class={(Chip, shown, holo.then_some(Holo), first.then_some(First), sku.is_none().then_some(Missing))}
        >
            if sku.is_some() {
                {name}
                if let Some(v) = variant {
                    " "{v}
                }
            } else {
                {name}" unavailable"
            }
        </span>
    }
}

#[component(css = IntakeScreen)]
fn QuantityCell<'a>(
    product: &'a Product,
    condition: Option<Condition>,
    screen: &'a Screen,
) -> impl Render {
    let shown = condition.map(|c| match c {
        Condition::NearMint => NearMint,
        Condition::LightlyPlayed => LightlyPlayed,
        Condition::ModeratelyPlayed => ModeratelyPlayed,
        Condition::HeavilyPlayed => HeavilyPlayed,
        Condition::Damaged => Damaged,
    });
    let sku = condition.map_or(product.unopened, |c| product.sku(c));
    let label = label(product, condition);
    html! {
        <span class={(Count, shown)}>
            if let Some(sku) = sku {
                let counted = Counted { sku, product: product.product_id, set: product.set_id, line: product.product_line_id, label: &label };
                <button type="button" tabindex="-1" data-step="-1" aria-label="One fewer">
                    "−"
                </button>
                <QuantityField
                    counted={&counted}
                    quantity={screen.quantities.get(&sku).copied().unwrap_or(0)}
                />
                <button type="button" data-step="1" aria-label="One more">"+"</button>
            }
        </span>
    }
}

/// `Pikachu - 025/165 - Common Reverse Holofoil Near Mint quantity`: printings of a product share
/// its name, so the label names the printing too.
fn label(product: &Product, condition: Option<Condition>) -> String {
    let printing = match product.variant.as_str() {
        "Normal" | "" => String::new(),
        variant => format!(" {variant}"),
    };
    format!(
        "{}{printing} {} quantity",
        product.display_name,
        condition.map_or("Unopened", Condition::name)
    )
}

/// A count field to draw again: its SKU, its label, and the product it belongs to.
pub struct Redrawn<'a> {
    product: &'a Product,
    sku: i32,
    label: String,
}

impl Redrawn<'_> {
    pub fn counted(&self) -> Counted<'_> {
        Counted {
            sku: self.sku,
            product: self.product.product_id,
            set: self.product.set_id,
            line: self.product.product_line_id,
            label: &self.label,
        }
    }
}

/// The count fields on the screen of the SKUs in `only`: after a queue, those it handed off.
pub fn redrawn<'a>(products: &'a [Product], only: &HashSet<i32>) -> Vec<Redrawn<'a>> {
    let mut fields = Vec::new();
    for product in products {
        let conditions: Vec<Option<Condition>> = if product.sealed {
            vec![None]
        } else {
            Condition::ALL.into_iter().map(Some).collect()
        };
        for condition in conditions {
            let sku = condition.map_or(product.unopened, |c| product.sku(c));
            if let Some(sku) = sku.filter(|s| only.contains(s)) {
                fields.push(Redrawn {
                    product,
                    sku,
                    label: label(product, condition),
                });
            }
        }
    }
    fields
}

/// A SKU's count. It carries where the SKU belongs, for the script to send with a change, and
/// is named by its SKU for the table's form without JavaScript.
#[component(css = IntakeScreen)]
pub fn QuantityField<'a>(counted: &'a Counted<'a>, quantity: i32) -> impl Patch {
    html! {
        <input
            id={QuantityId(counted.sku)}
            class={Quantity}
            name={counted.sku}
            value={quantity}
            inputmode="numeric"
            autocomplete="off"
            aria-label={counted.label}
            data-sku={counted.sku}
            data-product={counted.product}
            data-set={counted.set}
            data-line={counted.line}
        >
    }
}

/// What the last queue did: `Batch 12 queued with an estimate at ...`.
#[component(css = IntakeScreen)]
pub fn QueueNotice<'a>(message: Option<&'a str>) -> impl Patch {
    html! {
        <div id={QueueNoticeId} role="status">
            if let Some(message) = message {
                <Notice tone={Tone::Done}>{message}</Notice>
            }
        </div>
    }
}

/// Why the last change was not saved, or nothing.
#[component(css = IntakeScreen)]
pub fn IntakeError<'a>(message: Option<&'a str>) -> impl Patch {
    html! {
        <div id={IntakeErrorId}>
            if let Some(message) = message {
                <Notice tone={Tone::Warning}>{message}</Notice>
            }
        </div>
    }
}
