use std::{collections::HashMap, time::Duration};

use corten::{Route, ToJson, form::SubmitField, prelude::*, script::ElementId};
use corten_ui::{Choice, ComboBox, Picker};

use super::{background_batches::BackgroundBatches, queue_bar::QueueBar};
use crate::{
    features::inventory_intake::{
        catalog::{Condition, LANGUAGES, PageSize, Product, ProductOrder, ProductType, Scope, Set},
        page::{CountInput, Listing, Screen},
        queue::{self, Batches, QueueInput},
        url::{self, Selection},
    },
    layout::Notice,
    text::{Msg, msg},
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardPanel, CardSize},
        checkbox::Checkbox,
        combobox::Combobox,
        dialog::{Dialog, DialogFooter, DialogSize},
        input::Input,
        pagination::Pagination,
        select::Select,
        switch::Switch,
        table::{Sort, SortHeader, Table, TableLayout},
        visually_hidden::VisuallyHidden,
    },
};

// The set search as the script runs it, by the rule `catalog::search` follows.
corten::script::script!(pub mod set_search = "set_search.js");

#[derive(Id)]
struct FiltersId;
#[derive(Id)]
struct ConditionSelectId;
/// The set picker's control, which the Set label names: its select, and its text once the
/// script runs.
#[derive(Id)]
struct SetPickId;
/// The sets to pick from: a set's answer replaces them.
#[derive(Id)]
struct SetChoicesId;
#[derive(Id)]
struct SearchId;
/// What the search looks in: this set, or every set's card numbers.
#[derive(Id)]
struct SearchLabelId;
/// The summary of the filters folded away.
#[derive(Id)]
struct MoreFiltersId;

/// Why nothing is listed, when nothing is.
#[derive(Id)]
struct NothingListedId;
/// The products the filters keep, handed to the script.
#[derive(Id)]
struct ListedProductsId;
#[derive(Id)]
struct TableHeadingId;
#[derive(Id)]
pub struct IntakeErrorId;
#[derive(Id)]
pub struct QueueNoticeId;
#[derive(Id)]
struct PictureId;
/// A SKU's count form, `count-{sku}`: a count's answer replaces it.
#[derive(Id)]
struct CountId(i32);
/// The counts not yet queued, as the script reads them: a count's or a queue's answer replaces it.
#[derive(Id)]
pub struct UnqueuedId;

/// A SKU's count field: which SKU, where it belongs, and what it is called.
pub struct Counted<'a> {
    pub sku: i32,
    pub label: &'a str,
}

/// How often the background batches are read again.
pub const BATCHES_EVERY: Duration = Duration::from_secs(5);

/// What the screen shows of queuing: the background batches (or why they could not be read),
/// the queue form as it stands, and what the last queue did.
pub struct Queuing<'a> {
    pub batches: Result<&'a Batches, &'a str>,
    pub input: &'a QueueInput,
    pub errors: &'a Errors,
}

/// Every product the filters keep, as the screen's script gets them once with the page. It
/// searches a set's in the browser with no request, and
/// sorts, pages and draws any of them in another condition; a card number across sets is searched
/// by the server, which sends what it found.
#[derive(ToJson)]
pub struct IntakeListing {
    /// The address of the screen that lists them, which a set's answer puts in the address bar.
    pub address: String,
    /// Whether the script searches them: a set's products.
    pub searches: bool,
    /// The page the server drew, counting from 1.
    pub page: u32,
    /// Whether they are shown by name, Z to A.
    pub descending: bool,
    /// The query parameter of the page shown, which the script keeps in the address.
    pub page_field: String,
    /// A product's picture is its id between these two.
    pub picture: [String; 2],
    /// The thumbnail a row shows is a product's id between these two.
    pub thumbnail: [String; 2],
    /// A count form's id is its SKU after this.
    pub count_form: String,
    /// Each condition's name, in [`Condition::ALL`]'s order, as the condition select lists them.
    pub conditions: Vec<String>,
    /// What a sealed product's one SKU is called.
    pub unopened: String,
    /// What a row calls the printing that has no name of its own.
    pub normal: String,
    /// The sets the products are in, which each names by its place here.
    pub sets: Vec<String>,
    /// By name, A to Z.
    pub products: Vec<ListedProduct>,
}

/// A product as the script searches and draws it.
#[derive(ToJson)]
pub struct ListedProduct {
    pub product: i32,
    /// `Pikachu - 025/165 - Common`, which a search matches when no card number does.
    pub name: String,
    /// `Pikachu`, the name its row shows: the product's, without the card number it may end with.
    pub product_name: String,
    /// Its rarity, empty when it has none.
    pub rarity: String,
    /// Its card number, which a search matches first; empty when it has none.
    pub number: String,
    /// Its printing, empty when Normal.
    pub printing: String,
    /// Its language, empty when English.
    pub language: String,
    /// Its set's place in [`IntakeListing::sets`].
    pub set: u32,
    /// Its SKU in each condition, in [`Condition::ALL`]'s order, 0 where it has none; a sealed
    /// product's one SKU alone.
    pub skus: Vec<i32>,
    /// The copies in stock of each of [`ListedProduct::skus`], null where it has no SKU or the
    /// stock cannot be known.
    pub stock: Vec<Option<i32>>,
}

impl IntakeListing {
    fn of(listing: &Listing) -> IntakeListing {
        let mut sets: Vec<String> = Vec::new();
        let products = listing
            .listed
            .iter()
            .map(|product| {
                let label = set_label(product);
                let set = match sets.iter().position(|s| *s == label) {
                    Some(at) => at,
                    None => {
                        sets.push(label);
                        sets.len() - 1
                    }
                };
                ListedProduct {
                    product: product.product_id,
                    name: product.display_name.clone(),
                    product_name: name(product).to_owned(),
                    rarity: product.rarity.clone(),
                    number: product.card_number.clone().unwrap_or_default(),
                    printing: printing(product).to_owned(),
                    language: language(product).to_owned(),
                    set: set as u32,
                    skus: skus_of(product),
                    stock: skus_of(product)
                        .into_iter()
                        .map(|sku| in_stock(listing.stock.as_ref(), sku))
                        .collect(),
                }
            })
            .collect();
        IntakeListing {
            address: url::InventoryManager {
                selection: listing.selection.clone(),
            }
            .href(),
            searches: listing.scope == Scope::Set,
            page: listing.page as u32,
            descending: listing.selection.sort == Some(ProductOrder::NameDown),
            page_field: Selection::FIELDS.page.to_string(),
            picture: [PICTURE.0.to_owned(), PICTURE.1.to_owned()],
            thumbnail: [THUMBNAIL.0.to_owned(), THUMBNAIL.1.to_owned()],
            count_form: count_form_prefix(),
            conditions: Condition::ALL.iter().map(|c| c.name().to_owned()).collect(),
            unopened: UNOPENED.to_owned(),
            normal: NORMAL.to_owned(),
            sets,
            products,
        }
    }
}

/// The counts not yet queued, by SKU: the rows the script makes show them.
#[derive(ToJson)]
pub struct IntakeCounts {
    pub counts: Vec<PendingCount>,
}

#[derive(ToJson)]
pub struct PendingCount {
    pub sku: i32,
    pub quantity: i32,
}

impl IntakeCounts {
    fn of(quantities: &HashMap<i32, i32>) -> IntakeCounts {
        let mut counts: Vec<PendingCount> = quantities
            .iter()
            .map(|(&sku, &quantity)| PendingCount { sku, quantity })
            .collect();
        counts.sort_by_key(|c| c.sku);
        IntakeCounts { counts }
    }
}

/// The screen: the filters, a page of products with a count in the condition chosen, and the bar
/// that queues what is counted. The page brings every product the filters keep
/// ([`IntakeListing`]), and the script searches a set, sorts, pages and draws another condition
/// from it with no request; without JavaScript the GET form and the links do it on the server.
/// The filters are a GET `data-patch` form: with JavaScript another set, product line or filter
/// is answered with the parts that change with it ([`ListingParts`]), the script draws the rows
/// from its products and puts its address in the address bar.
#[component(css, js)]
pub fn IntakeScreen<'a>(
    screen: &'a Screen,
    error: Option<&'a str>,
    queuing: &'a Queuing<'a>,
) -> impl Render {
    let (filters, conditions, set, search, go, size, sort) = refs();
    let (rows, template, table, paging, range, previous, next) = refs();
    let (none, dialog, image) = refs();
    let t = Msg::default();
    let keys = js::Keys {
        filters,
        conditions,
        set,
        search,
        go,
        size,
        sort,
        rows,
        template,
        table,
        paging,
        range,
        previous,
        next,
        none,
        shown: t.js().intake_shown(),
        quantity: t.js().intake_quantity(),
        unavailable: t.js().intake_unavailable(),
        number: t.js().number(),
    };
    let f = Selection::FIELDS;
    let listing = &screen.listing;
    let selection = &listing.selection;
    let order = selection.sort.unwrap_or(ProductOrder::Name);
    let drawn: Vec<RowOf> = listing
        .products
        .iter()
        .map(|p| {
            RowOf::new(
                p,
                listing.condition,
                &screen.quantities,
                listing.stock.as_ref(),
                &t,
            )
        })
        .collect();
    let blank = RowOf::default();
    html! {
        <section
            class={IntakeScreen}
            on:document:keydown={js::keys(event, target, keys)}
            on:focusin={js::focused(event)}
            on:input={js::typed(event, keys)}
        >
            <header class={row(Space::_3)}>
                <h1>"Inventory Manager"</h1>
                <BackgroundBatches selection={selection} batches={queuing.batches} refused={None} />
                {ReadAgain { after: BATCHES_EVERY }.from(&url::Batches { selection: selection.clone() })}
            </header>
            <QueueNotice message={None} />
            <IntakeError message={error} />
            // A filter applied, or a set stepped with Page Up or Page Down, leaves focus on the
            // control the user is on (`data-keep-place`).
            <form
                id={FiltersId}
                ref={filters}
                method="get"
                action={url::InventoryManager { selection: Selection::default() }}
                class={(CardPanel { size: CardSize::Sm }, Filters)}
                aria-label="Filters"
                data-keep-place
                data-patch
                on:change={js::filtered(event, keys)}
                on:submit={js::submitted(event, keys)}
            >
                <label>
                    "Product Line"
                    <select class={Select {}} name={f.line}>
                        for l in &screen.lines {
                            <option value={l.id} selected={l.id == listing.line}>
                                {&l.name}
                            </option>
                        }
                    </select>
                </label>
                // The ref is the field's: a set's answer replaces the picker inside it.
                <div ref={set} class={SetField}>
                    <label for={SetPickId}>"Set"</label>
                    <SetPicker listing={listing} />
                </div>
                <Switch label="All sets">
                    <input
                        type="checkbox"
                        role="switch"
                        name={f.scope}
                        value={Scope::AllSets}
                        checked={listing.scope == Scope::AllSets}
                    >
                </Switch>
                <label>
                    "Condition"
                    <select
                        id={ConditionSelectId}
                        ref={conditions}
                        name={f.condition}
                        class={(Select {}, ConditionSelect)}
                    >
                        for c in Condition::ALL {
                            <option value={c} selected={c == listing.condition}>
                                {c.name()}
                            </option>
                        }
                    </select>
                </label>
                <details class={More}>
                    <MoreFilters selection={selection} />
                    <label>
                        "Product Type"
                        <select class={Select {}} name={f.product_type}>
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
                            <Checkbox label={language}>
                                <input
                                    type="checkbox"
                                    name={f.language}
                                    value={language}
                                    checked={selection.language.iter().any(|l| l == language)}
                                >
                            </Checkbox>
                        }
                    </fieldset>
                </details>
                <label class={SearchField}>
                    <SearchLabel scope={listing.scope} />
                    <span class={row(Space::_2)}>
                        <input
                            class={Input {}}
                            id={SearchId}
                            ref={search}
                            type="search"
                            name={f.search}
                            value={selection.search.as_deref().unwrap_or("")}
                            autocomplete="off"
                        >
                        <button
                            ref={go}
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Search"
                        </button>
                    </span>
                </label>
                // Sent while the products are shown Z to A: the script sorts in place and turns it
                // on or off, so a filter applied next keeps the order.
                <input
                    ref={sort}
                    type="hidden"
                    name={f.sort}
                    value={ProductOrder::NameDown}
                    disabled={order != ProductOrder::NameDown}
                >
                <label>
                    "Rows per page"
                    <select ref={size} class={Select {}} name={f.rows}>
                        for size in PageSize::ALL {
                            <option
                                value={size}
                                selected={selection.rows.unwrap_or_default() == size}
                            >
                                {size.count()}
                            </option>
                        }
                    </select>
                </label>
                <noscript>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Show"
                    </button>
                </noscript>
            </form>
            <section class={CardPanel { size: CardSize::Sm }} aria-labelledby={TableHeadingId}>
                <h2 id={TableHeadingId} class={VisuallyHidden {}}>"Add new inventory"</h2>
                <Table layout={TableLayout::Scroll}>
                    // No grid is shown without rows; the table stays for the script's refs.
                    // The columns are in the order a count is checked in: the copies in stock and
                    // the count first, in the same place whatever is listed, then what tells apart
                    // the rows a card number finds (the printing, the language, the condition), then
                    // the product. The set
                    // is the last column while one set is listed, and beside the SKU while every
                    // set is searched (`data-all-sets`, which the script keeps in step).
                    <table
                        ref={table}
                        class={Products}
                        hidden={listing.products.is_empty()}
                        data-all-sets={listing.scope == Scope::AllSets}
                    >
                        // The script sorts in place: a hover on the sort link fetches nothing.
                        // Its link is the screen sorted the other way, which the script keeps in
                        // step with the set shown: a header row cannot be part of a set's answer,
                        // as markup parsed outside a table drops a row's tags.
                        <thead data-no-prefetch>
                            <tr>
                                <th class={ImageColumn}>"Image"</th>
                                <th class={StockColumn}>"In Stock"</th>
                                <th class={QuantityColumn}>"Quantity"</th>
                                <th class={SkuColumn}>"SKU"</th>
                                <th class={(SetColumn, SetBeside)}>"Set"</th>
                                <th class={NumberColumn}>"Number"</th>
                                <SortHeader
                                    label="Product Name"
                                    sort={Some(match order {
                                        ProductOrder::Name => Sort::Ascending,
                                        ProductOrder::NameDown => Sort::Descending,
                                    })}
                                    ascending={&url::InventoryManager {
                                        selection: Selection {
                                            sort: None,
                                            page: None,
                                            ..selection.clone()
                                        },
                                    }}
                                    descending={&url::InventoryManager {
                                        selection: Selection {
                                            sort: Some(ProductOrder::NameDown),
                                            page: None,
                                            ..selection.clone()
                                        },
                                    }}
                                    first={Sort::Ascending}
                                    class={()}
                                    on:sort={js::sorted(event, target, keys)}
                                />
                                <th class={(SetColumn, SetLast)}>"Set"</th>
                            </tr>
                        </thead>
                        <tbody
                            ref={rows}
                            on:click={js::clicked(event, js::Picture { dialog, image, search })}
                            on:change={js::committed(event)}
                            on:connect={js::start(keys, searched(selection))}
                        >
                            for r in &drawn {
                                <IntakeRow
                                    key={r.key}
                                    condition={&r.condition}
                                    missing={r.missing}
                                    picture={&r.picture}
                                    thumbnail={&r.thumbnail}
                                    form={&r.form}
                                    sku={r.sku}
                                    stock={&r.stock}
                                    count={r.count}
                                    label={&r.label}
                                    submit={SubmitKey::field(CountInput::FIELDS.submit)}
                                    printing={&r.printing}
                                    printing_name={&r.printing_name}
                                    language={&r.language}
                                    condition_name={&r.condition_name}
                                    set={&r.set}
                                    number={&r.number}
                                    product_name={&r.product_name}
                                    rarity={&r.rarity}
                                    selection={selection}
                                />
                            }
                        </tbody>
                    </table>
                </Table>
                // The row the script copies for each product it draws.
                <template ref={template}>
                    <IntakeRow
                        key={blank.key}
                        condition={&blank.condition}
                        missing={blank.missing}
                        picture={&blank.picture}
                        thumbnail={&blank.thumbnail}
                        form={&blank.form}
                        sku={blank.sku}
                        stock={&blank.stock}
                        count={blank.count}
                        label={&blank.label}
                        submit={SubmitKey::template_field(CountInput::FIELDS.submit)}
                        printing={&blank.printing}
                        printing_name={&blank.printing_name}
                        language={&blank.language}
                        condition_name={&blank.condition_name}
                        set={&blank.set}
                        number={&blank.number}
                        product_name={&blank.product_name}
                        rarity={&blank.rarity}
                        selection={selection}
                    />
                </template>
                <ListedProducts listing={listing} />
                <UnqueuedCounts quantities={&screen.quantities} />
                <div ref={paging} class={(row(Space::_3), Paging)} hidden={listing.pages <= 1}>
                    <span ref={range} class={muted()}>{shown_of(listing, &t)}</span>
                    <span class={NoScript}>
                        <ProductPages
                            selection={selection}
                            current={listing.page}
                            pages={listing.pages}
                        />
                    </span>
                    <span class={(row(Space::_2), WithScript)}>
                        <button
                            ref={previous}
                            type="button"
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                            disabled={listing.page <= 1}
                            on:click={js::turned(keys, -1)}
                        >
                            "Previous"
                        </button>
                        <button
                            ref={next}
                            type="button"
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                            disabled={listing.page >= listing.pages}
                            on:click={js::turned(keys, 1)}
                        >
                            "Next"
                        </button>
                    </span>
                </div>
                // A search of the set that finds nothing, shown by the script as by the server.
                <div
                    ref={none}
                    hidden={!(listing.scope == Scope::Set && searched(selection) && listing.products.is_empty())}
                >
                    <Notice variant={AlertVariant::Info}>"No products match."</Notice>
                </div>
                <NothingListed listing={listing} />
            </section>
            <QueueBar
                selection={selection}
                totals={screen.totals}
                counted={&queue::fingerprint(&screen.quantities)}
                input={queuing.input}
                target={queuing.batches.ok().map(|b| &b.target)}
                errors={queuing.errors}
            />
            <dialog
                id={PictureId}
                ref={dialog}
                class={(Dialog { size: DialogSize::Md }, Picture)}
                closedby="any"
            >
                <img ref={image} alt="Product">
                <form method="dialog" class={DialogFooter {}}>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Close"
                    </button>
                </form>
            </dialog>
        </section>
    }
}

/// Whether the filters search for something.
fn searched(selection: &Selection) -> bool {
    selection
        .search
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
}

/// What changes on the screen with the filters, the answer to them with JavaScript: the sets to
/// choose from, what the search looks in, the summary of the filters folded away, why nothing is
/// listed, and the products, which the script draws the rows from with the counts it holds (and
/// the sort link from the address). The page draws each part in its place, so the two cannot
/// drift. None holds the screen's refs, which only the screen's own markup can put on an element.
#[component]
pub fn ListingParts<'a>(listing: &'a Listing) -> impl Patch {
    html! {
        <SetPicker listing={listing} />
        <SearchLabel scope={listing.scope} />
        <MoreFilters selection={&listing.selection} />

        <NothingListed listing={listing} />
        <ListedProducts listing={listing} />
    }
}

/// The product line's sets, the one listed picked: typing lists the sets whose label holds the
/// text anywhere, so a set whose name is not known is found by its release year. Without the
/// script it is a select. None to pick while every set is searched, or when the line has none.
#[component]
fn SetPicker<'a>(listing: &'a Listing) -> impl Patch {
    html! {
        let labels: Vec<String> = listing.sets.iter().map(Set::label).collect();
        let options: Vec<Choice<i32>> = listing.sets.iter().zip(&labels).map(|(set, label)| Choice::new(set.id, label)).collect();
        let picker = Picker { value: listing.set, disabled: listing.scope == Scope::AllSets || options.is_empty(), ..Picker::new(SetPickId, Selection::FIELDS.set, "Choose a set", "No matching sets", &options) };
        <div id={SetChoicesId}>
            <Combobox><ComboBox field={&picker} /></Combobox>
        </div>
    }
}

/// What the search looks in: this set, or every set's card numbers.
#[component]
fn SearchLabel(scope: Scope) -> impl Patch {
    html! {
        <span id={SearchLabelId}>
            match scope {
                Scope::Set => "Search this set by name or number",
                Scope::AllSets => "Card number, in every set",
            }
        </span>
    }
}

/// The summary of the filters folded away, which says what they do.
#[component]
fn MoreFilters<'a>(selection: &'a Selection) -> impl Patch {
    html! {
        <summary id={MoreFiltersId}>{more_filters(selection)}</summary>
    }
}

/// Why nothing is listed, when nothing is: every set searched without a card number or with one
/// found nowhere, or a set with no SKUs. A set's search that finds nothing is the script's.
#[component]
fn NothingListed<'a>(listing: &'a Listing) -> impl Patch {
    let term = listing
        .selection
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    html! {
        <div id={NothingListedId}>
            if listing.products.is_empty() {
                match (listing.scope, term) {
                    (Scope::AllSets, None) => {
                        <Notice variant={AlertVariant::Info}>
                            "Enter a card number to search across all sets in the selected product line."
                        </Notice>
                    }
                    (Scope::AllSets, Some(term)) => {
                        <Notice variant={AlertVariant::Warning}>
                            "No matches found for card number \""{term}
                            "\" in the selected product line."
                        </Notice>
                    }
                    (Scope::Set, None) => {
                        <Notice variant={AlertVariant::Info}>
                            "No SKUs available. Please select a product line and set to see available inventory options."
                        </Notice>
                    }
                    (Scope::Set, Some(_)) => {}
                }
            }
        </div>
    }
}

/// The products the filters keep, handed to the script when this joins the page: the page's
/// first, and each set's answer's after.
#[component(js = IntakeScreen)]
fn ListedProducts<'a>(listing: &'a Listing) -> impl Patch {
    let listed = IntakeListing::of(listing);
    html! {
        <span id={ListedProductsId} hidden on:connect={js::listed(&listed)}></span>
    }
}

/// The counts not yet queued, for the script: the rows it makes show them, and when a count's or
/// a queue's answer brings them again, the rows of SKUs no longer counted show none (a queue hands
/// them off, so its answer draws no count form of its own).
#[component(js = IntakeScreen)]
pub fn UnqueuedCounts<'a>(quantities: &'a HashMap<i32, i32>) -> impl Patch {
    let counts = IntakeCounts::of(quantities);
    html! {
        <span id={UnqueuedId} hidden on:connect={js::recounted(&counts)}></span>
    }
}

/// The pages of products: each link is the screen with the same filters, on that page. Without
/// JavaScript; the script pages with Previous and Next instead.
#[component]
fn ProductPages<'a>(selection: &'a Selection, current: usize, pages: usize) -> impl Render {
    html! {
        <Pagination
            label="Product pages"
            previous_label="Previous"
            next_label="Next"
            pages={pages}
            current={current}
            link={|page| url::InventoryManager {
                selection: Selection { page: Some(page), ..selection.clone() },
            }}
            on:link={None::<Handler>}
        />
    }
}

/// "101-200 of 1,390", the grid's footer (`intake.shown`, which the
/// script writes too).
fn shown_of(listing: &Listing, t: &Msg) -> String {
    let size = listing.selection.rows.unwrap_or_default().count();
    let first = (listing.page - 1) * size + 1;
    let last = first + listing.products.len() - 1;
    t.intake_shown(msg::IntakeShown {
        first: first.to_string(),
        last: last.to_string(),
        total: t.number(listing.matched as i64),
    })
    .to_string()
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

/// TCGplayer's picture of a product is its id between these two.
const PICTURE: (&str, &str) = (
    "https://tcgplayer-cdn.tcgplayer.com/product/",
    "_in_400x400.jpg",
);

/// TCGplayer's smaller picture of a product, the thumbnail a row shows, is its id between these
/// two.
const THUMBNAIL: (&str, &str) = (
    "https://tcgplayer-cdn.tcgplayer.com/product/",
    "_in_200x200.jpg",
);

/// What a sealed product's one SKU is called.
const UNOPENED: &str = "Unopened";

fn picture(product_id: i32) -> String {
    format!("{}{product_id}{}", PICTURE.0, PICTURE.1)
}

fn thumbnail(product_id: i32) -> String {
    format!("{}{product_id}{}", THUMBNAIL.0, THUMBNAIL.1)
}

/// `Base Set - 1999`.
fn set_label(product: &Product) -> String {
    match &product.release_year {
        Some(year) => format!("{} - {year}", product.set_name),
        None => product.set_name.clone(),
    }
}

/// The printing with no name of its own, as TCGplayer calls it and as a row does.
const NORMAL: &str = "Normal";

/// The product's printing, or nothing for a Normal one.
fn printing(product: &Product) -> &str {
    match product.variant.as_str() {
        NORMAL => "",
        variant => variant,
    }
}

/// The product's name as its row shows it: without the card number TCGplayer ends it with where
/// cards of a set share a name (`Alakazam ex - 065/165`), which the row shows in a cell of its own.
fn name(product: &Product) -> &str {
    product
        .card_number
        .as_deref()
        .filter(|number| !number.is_empty())
        .and_then(|number| product.product_name.strip_suffix(number))
        .and_then(|name| name.strip_suffix(" - "))
        .unwrap_or(&product.product_name)
}

/// The product's language, or nothing for English.
fn language(product: &Product) -> &str {
    match product.language.as_str() {
        "English" => "",
        language => language,
    }
}

/// Its SKU in each condition, in [`Condition::ALL`]'s order, 0 where it has none; a sealed
/// product's one SKU alone. The script reads the same list ([`ListedProduct::skus`]).
fn skus_of(product: &Product) -> Vec<i32> {
    if product.sealed {
        vec![product.unopened.unwrap_or(0)]
    } else {
        product.skus.iter().map(|s| s.unwrap_or(0)).collect()
    }
}

/// The copies of `sku` in `stock`: none when it is no SKU (0) or the stock cannot be known.
fn in_stock(stock: Option<&HashMap<i32, i32>>, sku: i32) -> Option<i32> {
    if sku == 0 {
        return None;
    }
    Some(stock?.get(&sku).copied().unwrap_or(0))
}

/// A row's key: the SKU it shows, or without one the product's first SKU, negated, so a row
/// drawn in another condition is another row and no two rows share a key.
fn key_of(skus: &[i32], sku: i32) -> i32 {
    if sku != 0 {
        return sku;
    }
    -skus.iter().copied().find(|&s| s != 0).unwrap_or(0)
}

/// The id of a SKU's count form, as [`CountForm`] writes it.
fn count_form(sku: i32) -> String {
    ElementId::of(&CountId(sku)).into()
}

/// What a count form's id has before its SKU, for the script to name the forms it makes.
fn count_form_prefix() -> String {
    let id = count_form(0);
    id.strip_suffix('0').unwrap_or(&id).to_owned()
}

/// A product's row in one condition: the holes of [`IntakeRow`], as the server fills them for
/// the page it draws, and the script (`rowOf` in `intake_screen.js`) for the rows it makes.
#[derive(Default)]
struct RowOf {
    key: i32,
    condition: String,
    missing: bool,
    picture: String,
    thumbnail: String,
    form: String,
    sku: i32,
    /// The copies in stock, empty when there is no SKU or the stock cannot be known.
    stock: String,
    count: i32,
    label: String,
    /// Empty when Normal, which the stylesheet draws plainly.
    printing: String,
    /// `Reverse Holofoil`, or `Normal`; nothing for a sealed product with no printing to name.
    printing_name: String,
    /// Empty when English.
    language: String,
    /// `Near Mint`, or `Damaged unavailable` without a SKU in the condition chosen.
    condition_name: String,
    set: String,
    number: String,
    product_name: String,
    rarity: String,
}

impl RowOf {
    fn new(
        product: &Product,
        condition: Condition,
        quantities: &HashMap<i32, i32>,
        stock: Option<&HashMap<i32, i32>>,
        t: &Msg,
    ) -> RowOf {
        let skus = skus_of(product);
        let shown = (!product.sealed).then_some(condition);
        let sku = product.sku(condition).unwrap_or(0);
        let named = shown.map_or(UNOPENED, Condition::name);
        let printing = printing(product);
        RowOf {
            key: key_of(&skus, sku),
            condition: shown.map(|c| c.to_string()).unwrap_or_default(),
            missing: sku == 0,
            picture: picture(product.product_id),
            thumbnail: thumbnail(product.product_id),
            form: if sku == 0 {
                String::new()
            } else {
                count_form(sku)
            },
            sku,
            stock: in_stock(stock, sku)
                .map_or_else(String::new, |n| t.number(i64::from(n)).to_string()),
            count: quantities.get(&sku).copied().unwrap_or(0),
            label: label(product, shown),
            printing: printing.to_owned(),
            printing_name: match (printing, product.sealed) {
                ("", true) => String::new(),
                ("", false) => NORMAL.to_owned(),
                (printing, _) => printing.to_owned(),
            },
            language: language(product).to_owned(),
            condition_name: if sku == 0 {
                t.intake_unavailable(named).to_string()
            } else {
                named.to_owned()
            },
            set: set_label(product),
            number: product.card_number.clone().unwrap_or_default(),
            product_name: name(product).to_owned(),
            rarity: product.rarity.clone(),
        }
    }
}

/// A product's row, in the condition chosen. `view` makes `IntakeRow` in `corten/views`: the
/// server draws a page of them and the script makes the rest from the screen's `<template>`, so
/// every part that changes from row to row is a hole. The row shows the product's thumbnail, a link
/// to its picture, which the table's click handler opens in a dialog; the handler steps its count
/// too.
///
/// Its cells are in the order a count is checked in. The count comes after the thumbnail and the
/// copies in stock alone, neither of which changes the room it takes, so its field is in the same
/// place whatever the row holds: the stock is what the count adds to, on its left. On its right is
/// what tells apart the rows a card number finds: the printing (filled, unless Normal), the
/// language unless English, and the condition. Then the card number, the name with its rarity, and the set, which has two
/// cells of which the table shows one (`data-all-sets`). The condition and the name take the
/// condition's color while the product has a SKU in it (`data-condition`); a row without one has
/// its count form hidden (`data-missing`), which the keys skip.
///
/// The count form is [`CountForm`]'s markup, which a count's answer replaces it with (a test
/// holds them the same), with the SKU as a hole. Its submit key is not one: the page's rows draw
/// theirs with `SubmitKey::field` and the `<template>` its keyless with `SubmitKey::template_field`,
/// so a row the script keeps keeps its form's key and the runtime gives a copied row one of its own
/// when its count is first sent.
#[component(view, css = IntakeScreen)]
pub fn IntakeRow<'a>(
    key: i32,
    condition: &'a str,
    missing: bool,
    picture: &'a str,
    thumbnail: &'a str,
    form: &'a str,
    sku: i32,
    stock: &'a str,
    count: i32,
    label: &'a str,
    submit: SubmitField,
    printing: &'a str,
    printing_name: &'a str,
    language: &'a str,
    condition_name: &'a str,
    set: &'a str,
    number: &'a str,
    product_name: &'a str,
    rarity: &'a str,
    selection: &'a Selection,
) -> impl Render {
    let c = CountInput::FIELDS;
    html! {
        <tr key={key} class={ProductRow} data-condition={condition} data-missing={missing}>
            <td class={ImageColumn}>
                <a href={picture} class={Thumbnail} tabindex="-1" aria-label="View picture">
                    <img src={thumbnail} alt="" loading="lazy" decoding="async">
                </a>
            </td>
            <td class={StockColumn}>{stock}</td>
            <td class={QuantityColumn}>
                <form
                    id={form}
                    class={Count}
                    method="post"
                    action={url::Count { selection: selection.clone() }}
                    hidden={missing}
                    data-patch
                >
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Icon }}
                        type="button"
                        tabindex="-1"
                        data-step="-1"
                        aria-label="One fewer"
                    >
                        "\u{2212}"
                    </button>
                    <input
                        class={Quantity}
                        name={c.quantity}
                        value={count}
                        inputmode="numeric"
                        autocomplete="off"
                        aria-label={label}
                        data-sku={sku}
                    >
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Icon }}
                        type="button"
                        data-step="1"
                        aria-label="One more"
                    >
                        "+"
                    </button>
                    <input type="hidden" name={c.sku} value={sku}>
                    <input type="hidden" name={c.seen} value={count}>
                    {submit}
                </form>
            </td>
            <td class={SkuColumn}>
                <div class={Sku}>
                    <span
                        class={(Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Solid }, Printing)}
                        data-printing={printing}
                    >
                        {printing_name}
                    </span>
                    <span
                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                    >
                        {language}
                    </span>
                    <span
                        class={(Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }, ConditionName)}
                    >
                        {condition_name}
                    </span>
                </div>
            </td>
            <td class={(SetColumn, SetBeside)}>{set}</td>
            <td class={NumberColumn}>{number}</td>
            <td class={NameColumn}>
                <span class={ProductName}>{product_name}</span>
                <span class={Rarity}>{rarity}</span>
            </td>
            <td class={(SetColumn, SetLast)}>{set}</td>
        </tr>
    }
}

/// `Pikachu - 025/165 - Common Reverse Holofoil Near Mint quantity`: printings of a product share
/// its name, so the label names the printing too (`intake.quantity`, which the script writes too).
pub fn label(product: &Product, condition: Option<Condition>) -> String {
    let named = match printing(product) {
        "" => product.display_name.clone(),
        printing => format!("{} {printing}", product.display_name),
    };
    Msg::default()
        .intake_quantity(msg::IntakeQuantity {
            product: named,
            condition: condition.map_or(UNOPENED, Condition::name),
        })
        .to_string()
}

/// A SKU's count, a form of its own: the script writes the new count into the field and submits
/// it with `seen`, the count the server last answered, so a count changed meanwhile is refused.
/// The answer is this form with the count stored. Without JavaScript, Enter in the field sends it.
/// [`IntakeRow`] draws the same form for the page's rows.
#[component(css = IntakeScreen)]
pub fn CountForm<'a>(
    counted: &'a Counted<'a>,
    quantity: i32,
    selection: &'a Selection,
) -> impl Patch {
    let c = CountInput::FIELDS;
    html! {
        <form
            id={CountId(counted.sku)}
            class={Count}
            method="post"
            action={url::Count { selection: selection.clone() }}
            data-patch
        >
            <button
                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Icon }}
                type="button"
                tabindex="-1"
                data-step="-1"
                aria-label="One fewer"
            >
                "\u{2212}"
            </button>
            <input
                class={Quantity}
                name={c.quantity}
                value={quantity}
                inputmode="numeric"
                autocomplete="off"
                aria-label={counted.label}
                data-sku={counted.sku}
            >
            <button
                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Icon }}
                type="button"
                data-step="1"
                aria-label="One more"
            >
                "+"
            </button>
            <input type="hidden" name={c.sku} value={counted.sku}>
            <input type="hidden" name={c.seen} value={quantity}>
            {SubmitKey::field(c.submit)}
        </form>
    }
}

/// What the last queue did: `Batch 12 queued with an estimate at ...`.
#[component(css = IntakeScreen)]
pub fn QueueNotice<'a>(message: Option<&'a str>) -> impl Patch {
    html! {
        <div id={QueueNoticeId}>
            if let Some(message) = message {
                <Notice variant={AlertVariant::Success}>{message}</Notice>
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
                <Notice variant={AlertVariant::Warning}>{message}</Notice>
            }
        </div>
    }
}
#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use corten::{SubmitKey, form::SubmitField, script::ElementId, view::Render};

    use super::{
        CountForm, Counted, IntakeListing, IntakeRow, ListedProductsId, ListingParts,
        MoreFiltersId, NothingListedId, ProductPages, RowOf, SearchLabelId, SetChoicesId,
        SetPickId, count_form, count_form_prefix, key_of, skus_of,
    };
    use crate::{
        features::inventory_intake::{
            catalog::{Condition, Product, Scope, Set},
            page::{CountInput, Listing},
            url::Selection,
        },
        text::Msg,
    };

    /// A Base Set card in Near Mint and Lightly Played only.
    fn card() -> Product {
        Product {
            product_id: 1,
            display_name: "Pikachu - 58/102 - Common".into(),
            product_name: "Pikachu".into(),
            rarity: "Common".into(),
            language: "English".into(),
            set_name: "Base Set".into(),
            release_year: Some("1999".into()),
            card_number: Some("58/102".into()),
            variant: "Reverse Holofoil".into(),
            sealed: false,
            set_id: 1,
            product_line_id: 3,
            unopened: None,
            skus: [Some(10), Some(11), None, None, None],
        }
    }

    /// A row as the page draws it, with a key of its own (`submit`), or as the `<template>` does.
    fn drawn_with(row: &RowOf, selection: &Selection, submit: SubmitField) -> String {
        IntakeRow {
            key: row.key,
            condition: &row.condition,
            missing: row.missing,
            picture: &row.picture,
            thumbnail: &row.thumbnail,
            form: &row.form,
            sku: row.sku,
            stock: &row.stock,
            count: row.count,
            label: &row.label,
            submit,
            printing: &row.printing,
            printing_name: &row.printing_name,
            language: &row.language,
            condition_name: &row.condition_name,
            set: &row.set,
            number: &row.number,
            product_name: &row.product_name,
            rarity: &row.rarity,
            selection,
        }
        .to_html()
    }

    fn drawn(row: &RowOf, selection: &Selection) -> String {
        drawn_with(row, selection, SubmitKey::field(CountInput::FIELDS.submit))
    }

    /// A row shows the condition chosen: its SKU, count and label, and the condition the
    /// stylesheet colors it by (`getConditionColor`). Without a SKU in that
    /// condition its count form is hidden and the SKU is marked unavailable; its key is another
    /// row's than the product's rows with a SKU.
    #[test]
    fn a_row_shows_the_condition_chosen() {
        let product = card();
        let t = Msg::default();
        let counts = HashMap::from([(11, 4)]);
        let selection = Selection::default();
        let lp = RowOf::new(&product, Condition::LightlyPlayed, &counts, None, &t);
        let html = drawn(&lp, &selection);
        assert_eq!((lp.key, lp.sku, lp.count), (11, 11, 4));
        assert!(html.contains("data-condition=\"lightly-played\""), "{html}");
        assert!(!html.contains("data-missing"), "{html}");
        assert!(
            html.contains("data-printing=\"Reverse Holofoil\">Reverse Holofoil<"),
            "{html}"
        );
        assert!(html.contains(">Lightly Played<"), "{html}");
        assert!(
            html.contains(
                "aria-label=\"Pikachu - 58/102 - Common Reverse Holofoil Lightly Played quantity\""
            ),
            "{html}"
        );
        assert!(
            html.contains(&format!("id=\"{}\"", count_form(11))),
            "{html}"
        );
        let dmg = RowOf::new(&product, Condition::Damaged, &counts, None, &t);
        let html = drawn(&dmg, &selection);
        assert_eq!((dmg.key, dmg.sku, dmg.missing), (-10, 0, true));
        assert!(html.contains("data-missing"), "{html}");
        assert!(html.contains(" hidden data-patch"), "{html}");
        assert!(html.contains(">Damaged unavailable<"), "{html}");
        assert_eq!(key_of(&skus_of(&product), 0), -10);
    }

    /// The count comes before everything a row says about its product but the thumbnail and the
    /// copies in stock, so its field does not move with what is listed, and what tells apart the
    /// rows a card number finds is next to it: the printing, the language unless English, then the
    /// condition. The card number, the name and its rarity follow, each in a cell of its own, and
    /// the set is there twice, for the table to show beside the SKU or last.
    #[test]
    fn a_row_puts_the_count_before_what_tells_the_rows_apart() {
        let t = Msg::default();
        let counts = HashMap::new();
        let selection = Selection::default();
        let japanese = Product {
            language: "Japanese".into(),
            ..card()
        };
        let stock = HashMap::from([(10, 7)]);
        let row = RowOf::new(&japanese, Condition::NearMint, &counts, Some(&stock), &t);
        let html = drawn(&row, &selection);
        let at = |part: &str| html.find(part).unwrap_or_else(|| panic!("{part}: {html}"));
        let order = [
            at("<img"),
            at(">7</td>"),
            at("<form"),
            at(">Reverse Holofoil<"),
            at(">Japanese<"),
            at(">Near Mint<"),
            at(">Base Set - 1999<"),
            at(">58/102<"),
            at(">Pikachu<"),
            at(">Common<"),
            html.rfind(">Base Set - 1999<").unwrap(),
        ];
        assert!(order.is_sorted_by(|a, b| a < b), "{order:?}: {html}");

        // A Normal printing is named, with nothing for the stylesheet to fill; English is not.
        let normal = Product {
            variant: "Normal".into(),
            ..card()
        };
        let row = RowOf::new(&normal, Condition::NearMint, &counts, None, &t);
        assert_eq!(
            (
                row.printing.as_str(),
                row.printing_name.as_str(),
                row.language.as_str()
            ),
            ("", "Normal", "")
        );
        // A name that ends with the card number is shown without it, and no other is changed.
        let numbered = |product_name: &str| {
            let product = Product {
                product_name: product_name.into(),
                ..card()
            };
            RowOf::new(&product, Condition::NearMint, &counts, None, &t).product_name
        };
        assert_eq!(numbered("Pikachu - 58/102"), "Pikachu");
        assert_eq!(
            numbered("Pikachu - 58/102 (Cosmos Holo)"),
            "Pikachu - 58/102 (Cosmos Holo)"
        );
        assert_eq!(numbered("58/102"), "58/102");
        // A sealed product has no printing to name.
        let sealed = Product {
            sealed: true,
            unopened: Some(12),
            ..normal
        };
        let row = RowOf::new(&sealed, Condition::NearMint, &counts, None, &t);
        assert_eq!(
            (row.printing_name.as_str(), row.condition_name.as_str()),
            ("", "Unopened")
        );
    }

    /// A count's answer replaces a row's count form with `CountForm`, so the row draws the same
    /// markup (all but the submit key, which each form draws new), and the script's holes stay
    /// where it finds them.
    #[test]
    fn a_row_draws_the_count_form_a_count_answers_with() {
        let product = card();
        let selection = Selection {
            line: Some(3),
            search: Some("58".into()),
            ..Selection::default()
        };
        let row = RowOf::new(
            &product,
            Condition::NearMint,
            &HashMap::from([(10, 2)]),
            None,
            &Msg::default(),
        );
        let html = drawn(&row, &selection);
        let form = |html: &str| {
            let start = html.find("<form").expect("a form");
            let end = html.find("</form>").expect("its end") + "</form>".len();
            let form = &html[start..end];
            let key = form.find("data-submit value=\"").expect("a submit key") + 19;
            format!("{}KEY{}", &form[..key], &form[key + 36..])
        };
        let answered = CountForm {
            counted: &Counted {
                sku: 10,
                label: &row.label,
            },
            quantity: 2,
            selection: &selection,
        }
        .to_html();
        assert_eq!(form(&html), form(&answered));
    }

    /// The row the script copies holds no submit key, so the runtime gives each copy's count
    /// form one of its own when it is first sent: a key copies shared would apply only the first
    /// SKU's count.
    #[test]
    fn a_copied_row_has_no_submit_key_of_its_own_yet() {
        let row = RowOf::default();
        let html = drawn_with(
            &row,
            &Selection::default(),
            SubmitKey::template_field(CountInput::FIELDS.submit),
        );
        assert!(html.contains(r#"name="submit" data-submit>"#), "{html}");
    }

    /// The script names a count form as `CountForm` does: the prefix, then the SKU.
    #[test]
    fn the_script_names_count_forms_as_the_server_does() {
        assert_eq!(count_form(1234), format!("{}1234", count_form_prefix()));
    }

    /// Page Up and Page Down step the set, empty the search, leave focus in it with its text
    /// selected and send the filters (whose `data-keep-place` keeps that focus through the
    /// navigation), from the search or a count field alike: never the old search, never a count
    /// field. The picker's first option is no set, so the keys step past it, and from it to the
    /// first set or the last. With every set searched there is no set to step. The handler runs
    /// in node with stand-ins for the page and the runtime (the test runs in the crate's
    /// directory).
    #[test]
    fn page_up_and_down_start_a_new_search_in_the_next_set() {
        let script = r#"
            import { registerHooks } from "node:module";
            // The runtime's modules, as far as the handler reaches them.
            const stubs = {
                corten: "export const keep = (init) => (globalThis.kept ??= init());",
                "corten/views": "export class IntakeRow {} export const rows = () => { throw new Error('no rows'); };",
            };
            registerHooks({
                resolve(specifier, context, next) {
                    const code = stubs[specifier];
                    if (code === undefined) return next(specifier, context);
                    return { url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true };
                },
            });
            class Node {
                contains(other) { return other === this || (this.kids ?? []).includes(other); }
            }
            class Element extends Node {
                closest() { return null; }
            }
            class HTMLInputElement extends Element {
                constructor(dataset) { super(); this.dataset = dataset; this.value = "58"; this.selected = false; }
                focus() { document.activeElement = this; }
                select() { this.selected = true; }
            }
            Object.assign(globalThis, { Node, Element, HTMLInputElement, document: { body: new Node(), activeElement: null } });
            const { keys } = await import("./src/features/inventory_intake/views/intake_screen.js");
            const screen = new Node();
            const search = new HTMLInputElement({});
            const quantity = new HTMLInputElement({ sku: "10" });
            screen.kids = [search, quantity];
            const sent = [];
            // No set, then three sets, the first picked.
            const sets = { disabled: false, options: { length: 4 }, selectedIndex: 1 };
            const k = {
                search,
                set: { querySelector: () => sets },
                filters: { requestSubmit: (...by) => sent.push(by) },
            };
            const press = (key, target) => {
                const event = { key, target, defaultPrevented: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; } };
                search.value = "58";
                search.selected = false;
                document.activeElement = target;
                keys(event, screen, k);
                return [event.defaultPrevented, sets.selectedIndex, search.value, document.activeElement === search, search.selected, sent.length, sent.at(-1)?.length].join(" ");
            };
            console.log(press("PageDown", search));
            console.log(press("PageDown", quantity));
            console.log(press("PageDown", quantity));
            console.log(press("PageUp", quantity));
            console.log(press("PageUp", search));
            console.log(press("PageUp", search));
            sets.selectedIndex = 0;
            console.log(press("PageDown", search));
            sets.selectedIndex = 0;
            console.log(press("PageUp", search));
            sets.disabled = true;
            console.log(press("PageDown", search));
        "#;
        let out = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let lines: Vec<String> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            lines,
            [
                // Prevented, the set chosen, the search, focus in it, its text selected, the
                // filters sent so far, and with no submitter.
                "true 2  true true 1 0",
                "true 3  true true 2 0",
                // Past the last set is the first, and before the first the last.
                "true 1  true true 3 0",
                "true 3  true true 4 0",
                "true 2  true true 5 0",
                "true 1  true true 6 0",
                // No set picked: the first set down, the last up.
                "true 1  true true 7 0",
                "true 3  true true 8 0",
                // Every set searched: Page Down is the browser's, and the search is left as it is.
                "false 3 58 true false 8 0",
            ]
        );
    }

    /// A set picked in the picker is listed as Page Down lists the next: the search emptied, with
    /// focus, and the filters sent. The picker emptied and left picks none, so the set listed is
    /// asked for again and the search is left as it is. The picker's text changing is no filter,
    /// and nothing is sent for it. In node, with stand-ins for the page and the runtime, as above.
    #[test]
    fn a_set_picked_is_listed_to_search_afresh() {
        let script = r#"
            import { registerHooks } from "node:module";
            const stubs = {
                corten: "export const keep = (init) => (globalThis.kept ??= init());",
                "corten/views": "export class IntakeRow {} export const rows = () => { throw new Error('no rows'); };",
            };
            registerHooks({
                resolve(specifier, context, next) {
                    const code = stubs[specifier];
                    if (code === undefined) return next(specifier, context);
                    return { url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true };
                },
            });
            class HTMLInputElement {
                constructor(role) { this.role = role; this.value = "58"; this.selected = false; }
                getAttribute(name) { return name === "role" ? this.role : null; }
                focus() { document.activeElement = this; }
                select() { this.selected = true; }
            }
            Object.assign(globalThis, { HTMLInputElement, document: { activeElement: null } });
            const { filtered } = await import("./src/features/inventory_intake/views/intake_screen.js");
            const search = new HTMLInputElement(null);
            const text = new HTMLInputElement("combobox");
            const sent = [];
            const sets = { value: "2", options: [{ value: "", defaultSelected: false }, { value: "1", defaultSelected: true }, { value: "2", defaultSelected: false }] };
            const k = { search, set: { querySelector: () => sets }, filters: { requestSubmit: (...by) => sent.push(by) } };
            const changed = (target) => {
                search.value = "58";
                search.selected = false;
                document.activeElement = text;
                filtered({ target }, k);
                return [sets.value, search.value, document.activeElement === search, search.selected, sent.length].join(" ");
            };
            console.log(changed(sets));
            sets.value = "";
            console.log(changed(sets));
            console.log(changed(text));
        "#;
        let out = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let lines: Vec<String> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            lines,
            [
                // The set the select holds, the search, focus in it, its text selected, and the
                // filters sent so far.
                "2  true true 1",
                "1 58 false false 2",
                "1 58 false false 2",
            ]
        );
    }

    /// A set's answer is the parts of the screen that change with the filters, each with the id the
    /// page draws it with, so each replaces its own: the set picked among the line's, and its
    /// products for the script, with the address that lists them. It holds none of the screen's
    /// refs, which a part drawn outside the screen cannot name, and no table row, which the
    /// browser would parse apart outside a table.
    #[test]
    fn a_sets_answer_draws_the_parts_that_change_with_it() {
        let selection = Selection {
            line: Some(3),
            set: Some(2),
            ..Selection::default()
        };
        let set = |id: i32, name: &str| Set {
            id,
            name: name.into(),
            abbreviation: None,
            release_date: None,
        };
        let listing = Listing {
            selection: selection.clone(),
            line: 3,
            sets: vec![set(1, "Base Set"), set(2, "Jungle")],
            set: Some(2),
            scope: Scope::Set,
            condition: Condition::NearMint,
            listed: vec![card()],
            products: vec![card()],
            page: 1,
            pages: 1,
            matched: 1,
            stock: Some(HashMap::from([(11, 3)])),
        };
        let html = ListingParts { listing: &listing }.to_html();
        let ids: [ElementId; 6] = [
            ElementId::of(&SetChoicesId),
            ElementId::of(&SetPickId),
            ElementId::of(&SearchLabelId),
            ElementId::of(&MoreFiltersId),
            ElementId::of(&NothingListedId),
            ElementId::of(&ListedProductsId),
        ];
        for id in ids {
            let id: String = id.into();
            assert_eq!(
                html.matches(&format!("id=\"{id}\"")).count(),
                1,
                "{id}: {html}"
            );
        }
        // The only refs are the set picker's own parts, which its script finds under its root.
        let refs: Vec<&str> = html
            .split("data-ref=\"")
            .skip(1)
            .map(|rest| rest.split_once('"').unwrap().0)
            .collect();
        assert_eq!(
            refs,
            ["select", "input", "popup", "list", "empty"],
            "{html}"
        );
        assert!(!html.contains("<tr"), "{html}");
        // The picker shows the set listed, in its select and in its text.
        assert!(html.contains(r#"<option value="2" selected>"#), "{html}");
        assert!(
            html.contains(r#"role="combobox""#) && html.contains(r#"value="Jungle""#),
            "{html}"
        );
        assert!(!html.contains(r#"<option value="1" selected>"#), "{html}");

        let listed = IntakeListing::of(&listing);
        assert_eq!(listed.address, "/inventory-manager?line=3&set=2");
        assert_eq!(listed.products.len(), 1);
        assert_eq!(
            listed.products[0].stock,
            [Some(0), Some(3), None, None, None]
        );
    }

    /// A row shows how many copies of its SKU the store has in stock: none listed is 0, and
    /// nothing is shown without a SKU in the condition or when the stock cannot be known.
    #[test]
    fn a_row_shows_the_copies_in_stock() {
        let product = card();
        let t = Msg::default();
        let counts = HashMap::new();
        let stock = HashMap::from([(11, 1234)]);
        let row = |condition, stock| RowOf::new(&product, condition, &counts, stock, &t);
        assert_eq!(row(Condition::LightlyPlayed, Some(&stock)).stock, "1,234");
        assert_eq!(row(Condition::NearMint, Some(&stock)).stock, "0");
        assert_eq!(row(Condition::Damaged, Some(&stock)).stock, "");
        assert_eq!(row(Condition::LightlyPlayed, None).stock, "");
        let lp = row(Condition::LightlyPlayed, Some(&stock));
        let html = drawn(&lp, &Selection::default());
        assert!(html.contains(">1,234</td>"), "{html}");
    }

    /// The products the page brings are the screen's to draw from, with nothing drawn again and
    /// the address left as it is. A set's answer brings its own: its rows are drawn at once and
    /// its address becomes a new history entry, so Back returns to the set before; an answer at
    /// the address already shown adds no entry. In node, with stand-ins for the page and the
    /// runtime, as above.
    #[test]
    fn a_sets_answer_draws_its_rows_and_puts_its_address_in_the_history() {
        let script = r#"
            import { registerHooks } from "node:module";
            const stubs = {
                corten: "export const keep = (init) => (globalThis.kept ??= init());",
                "corten/views": "export class IntakeRow {} export const rows = () => Object.assign([], { replace(next) { globalThis.rows = next; globalThis.drawn = next.map((r) => r.sku); } });",
            };
            registerHooks({
                resolve(specifier, context, next) {
                    const code = stubs[specifier];
                    if (code === undefined) return next(specifier, context);
                    return { url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true };
                },
            });
            const at = (query) => "http://localhost/inventory-manager?" + query + "&condition=near-mint&rows=100";
            const pushed = [];
            globalThis.HTMLAnchorElement = class {};
            globalThis.location = { href: at("line=3&set=1") };
            globalThis.history = {
                state: null,
                pushState(_, __, url) { pushed.push(String(url)); location.href = String(url); },
                replaceState(_, __, url) { location.href = String(url); },
            };
            const { listed, start } = await import("./src/features/inventory_intake/views/intake_screen.js");
            const k = {
                conditions: { selectedIndex: 0, value: "near-mint", name: "condition" },
                size: { value: "100", name: "rows" },
                sort: { value: "name-down", name: "sort", disabled: true },
                search: { value: "", name: "search" },
                rows: {}, template: {}, none: {}, paging: {}, range: {}, previous: {}, next: {},
                table: { toggleAttribute(name, on) { this[name] = on; } },
                shown: () => "", number: String, quantity: () => "", unavailable: ({ condition }) => condition + " unavailable",
            };
            const printings = ["", "Reverse Holofoil"];
            const listing = (query, skus, searches = true) => ({
                address: at(query).slice("http://localhost".length),
                searches, page: 1, descending: false, page_field: "page", picture: ["", ""], thumbnail: ["", ""],
                count_form: "count-", conditions: ["Near Mint"], unopened: "Unopened", normal: "Normal", sets: ["Base Set"],
                products: skus.map((sku, i) => ({
                    product: i, name: "P" + i + " - 58/102 - Common", product_name: "P" + i, rarity: "Common", number: "58/102",
                    printing: printings[i], language: i ? "Japanese" : "", set: 0, skus: [sku, 0], stock: [1, null],
                })),
            });
            const said = (r) => [r.printing, r.printing_name, r.language, r.condition_name, r.set, r.number, r.product_name, r.rarity].join("|");
            start(k, false);
            listed(listing("line=3&set=1", [10]));
            console.log(pushed.length, globalThis.drawn ?? "none");
            listed(listing("line=3&set=2", [20, 21]));
            console.log(pushed.length, globalThis.drawn.join(","), new URL(location.href).search);
            console.log(globalThis.rows.map(said).join(" "), k.table["data-all-sets"]);
            listed(listing("line=3&set=2", [20, 21]));
            console.log(pushed.length);
            // A product with no SKU in the condition chosen, and one sealed, with every set searched.
            listed(listing("line=3&set=2", [0, 30], false));
            console.log(globalThis.rows.map(said).join(" "), k.table["data-all-sets"]);
            const sealed = listing("line=3&set=2", [40], false);
            sealed.products[0].skus = [40];
            listed(sealed);
            console.log(said(globalThis.rows[0]));
        "#;
        let out = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let lines: Vec<String> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            lines,
            [
                "0 none",
                "1 20,21 ?line=3&set=2&condition=near-mint&rows=100",
                // What each row says, as `RowOf::new` fills it, and one set is listed.
                "|Normal||Near Mint|Base Set|58/102|P0|Common Reverse Holofoil|Reverse Holofoil|Japanese|Near Mint|Base Set|58/102|P1|Common false",
                "1",
                "|Normal||Near Mint unavailable|Base Set|58/102|P0|Common Reverse Holofoil|Reverse Holofoil|Japanese|Near Mint|Base Set|58/102|P1|Common true",
                "|||Unopened|Base Set|58/102|P0|Common",
            ]
        );
    }

    /// Every page link keeps the filters and changes only the page; the current one is marked, and
    /// Previous and Next step one page.
    #[test]
    fn a_page_link_keeps_the_filters() {
        let selection = Selection {
            line: Some(3),
            search: Some("pika chu".into()),
            page: Some(3),
            ..Selection::default()
        };
        let html = ProductPages {
            selection: &selection,
            current: 3,
            pages: 9,
        }
        .to_html();
        let links: Vec<&str> = html
            .split("href=\"")
            .skip(1)
            .map(|rest| rest.split_once('"').unwrap().0)
            .collect();
        // Previous, 1 to 5, 9, Next.
        assert_eq!(links.len(), 8, "{html}");
        for link in &links {
            assert!(link.starts_with("/inventory-manager?"), "{link}");
            assert!(
                link.contains("line=3") && link.contains("search=pika"),
                "{link}"
            );
            assert_eq!(link.matches("page=").count(), 1, "{link}");
        }
        let page = |n: usize| format!("page={n}");
        assert!(
            links[0].contains(&page(2)) && links[7].contains(&page(4)),
            "{html}"
        );
        assert!(links[6].contains(&page(9)), "{html}");
        assert!(
            html.contains("rel=\"prev\"") && html.contains("rel=\"next\""),
            "{html}"
        );
        assert_eq!(html.matches("aria-current=\"page\"").count(), 1, "{html}");
        let current = html.split("aria-current=\"page\"").next().unwrap();
        assert!(
            current
                .rsplit("href=\"")
                .next()
                .unwrap()
                .starts_with("/inventory-manager?"),
            "{html}"
        );
        assert!(
            current
                .rsplit("href=\"")
                .next()
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .contains(&page(3)),
            "{html}"
        );
    }
}
