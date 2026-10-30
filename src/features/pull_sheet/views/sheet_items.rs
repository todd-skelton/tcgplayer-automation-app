use corten::{Href, prelude::*};
use serde::Deserialize;

use super::{ItemCard, ItemRow, SortBy, picture};
use crate::{
    features::pull_sheet::{
        items::{Grade, Item, Printing},
        url::SheetQuery,
    },
    text::Msg,
    theme::*,
};

/// What the summary counts, over the whole sheet whatever the filter shows.
pub struct Summary {
    pub items: usize,
    pub quantity: u32,
    pub not_found: usize,
    pub orders: usize,
}

impl Summary {
    pub fn of(items: &[Item], orders: usize) -> Self {
        Summary {
            items: items.len(),
            quantity: items.iter().map(|i| i.quantity).sum(),
            not_found: items.iter().filter(|i| i.catalog.is_none()).count(),
            orders,
        }
    }
}

/// Which way the items show. Only CSS reads it (`:has(:checked)`), so the choice needs no script
/// and is not sent anywhere; the struct names the radios.
#[derive(Deserialize, Fields)]
#[expect(
    dead_code,
    reason = "the struct only names the radios; nothing reads a submitted choice"
)]
pub struct ShowAs {
    pub layout: String,
}

/// Where the filter and the sort go without JavaScript, on the page that shows the items: the
/// filter's GET form, the fields it keeps (`keep`, such as the page's step), and each column's
/// link. The page's route takes [`SheetQuery`], so the names agree; each page passes its own
/// typed route.
pub struct Paging<'a> {
    pub action: &'a dyn Href,
    pub keep: Vec<(&'static str, String)>,
    pub filters: &'a SheetQuery,
    pub link: &'a dyn Fn(SortBy) -> Box<dyn Href + 'a>,
}

/// What is drawn on an item besides the sheet's columns (what it sold for, on the shipping
/// workflow's sheet); `true` when it is drawn over the card's picture.
pub type Detail<'a> = &'a dyn Fn(&Item, bool) -> Box<dyn Render + 'a>;

/// A sheet's items as picture cards or a table, with the filter and the chips that count them.
/// `lead` starts the toolbar. The filter and the table's sort run in the browser over both lists
/// (each a list of views, so a handler reads a row's fields by name); without JavaScript the
/// filter is a GET form and the column headers are links the server sorts by.
#[component(css, js)]
pub fn SheetItems<'a>(
    items: &'a [Item],
    summary: &'a Summary,
    lead: &'a dyn Render,
    paging: &'a Paging<'a>,
    detail: Option<Detail<'a>>,
    t: Msg,
) -> impl Render {
    let (cards, rows, shown, empty, dialog, image, open) = refs();
    let found = js::Found {
        cards,
        rows,
        shown,
        empty,
        text: t.js().pull_sheet_showing(),
        number: t.js().number(),
    };
    let q = paging.filters.q.as_deref().unwrap_or("");
    let (f, l) = (SheetQuery::FIELDS, ShowAs::FIELDS);
    let columns = [
        (SortBy::Product, "Product"),
        (SortBy::Number, "#"),
        (SortBy::Set, "Set"),
        (SortBy::Condition, "Condition"),
        (SortBy::Rarity, "Rarity"),
        (SortBy::Quantity, "Qty"),
        (SortBy::ProductLine, "Product Line"),
    ];
    html! {
        <div>
            <div class={(panel(), mb_4(), Toolbar)}>
                {lead}
                <form method="get" action={paging.action} class={(row(Space::_2), Filter)}>
                    for (name, value) in &paging.keep {
                        <input type="hidden" name={*name} value={value.as_str()}>
                    }
                    <input
                        type="search"
                        name={f.q}
                        value={q}
                        placeholder="Filter items..."
                        aria-label="Filter items"
                        on:input={js::filter(target, found)}
                    >
                    if let Some(sort) = paging.filters.sort {
                        <input type="hidden" name={f.sort} value={sort}>
                    }
                    <button class={NoScript}>"Filter"</button>
                </form>
                <fieldset class={Choice}>
                    <legend>"Show as"</legend>
                    <label>
                        <input type="radio" name={l.layout} value="grid" class={GridChoice} checked>
                        "Grid"
                    </label>
                    <label>
                        <input type="radio" name={l.layout} value="table" class={TableChoice}>
                        "Table"
                    </label>
                </fieldset>
            </div>
            <div class={(row(Space::_2), mb_4())}>
                <span class={(Chip, Filled)}>{summary.items}" items"</span>
                <span class={Chip}>{summary.quantity}" total qty"</span>
                if summary.not_found > 0 {
                    <span class={(Chip, Warning)}>{summary.not_found}" not in database"</span>
                }
                if summary.orders > 0 {
                    <span class={(Chip, Info)}>{summary.orders}" orders"</span>
                }
                <output ref={shown} class={(Chip, Info)} hidden={q.is_empty()}>
                    if !q.is_empty() { "Showing "{items.len()}" of "{summary.items} }
                </output>
            </div>
            <div ref={cards} class={Cards}>
                for (key, item) in items.iter().enumerate() {
                    let drawn = detail.map(|d| d(item, true));
                    <ItemCard
                        key={key}
                        search={&item.search_text()}
                        item={item}
                        detail={drawn.as_ref().map(|d| d as &dyn Render)}
                    />
                }
            </div>
            <div class={TableBox}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th><span class={Hidden}>"Picture"</span></th>
                            for (by, label) in columns {
                                <th
                                    aria-sort={(paging.filters.sort == Some(by)).then_some("ascending")}
                                >
                                    <a
                                        href={(paging.link)(by)}
                                        on:click={js::sortBy(event, target, found, by)}
                                    >
                                        {label}
                                    </a>
                                </th>
                            }
                            <th>"Order"</th>
                            if detail.is_some() { <th>"Value"</th> }
                        </tr>
                    </thead>
                    <tbody
                        ref={rows}
                        on:click={js::showPicture(event, open.closest(), dialog, image)}
                    >
                        for (key, item) in items.iter().enumerate() {
                            let drawn = detail.map(|d| d(item, false));
                            <ItemRow
                                key={key}
                                search={&item.search_text()}
                                name={&item.product_name}
                                number={&item.number}
                                set={&item.set}
                                condition={item.shown_condition()}
                                grade={Grade::of(item.shown_condition())}
                                printing={&Printing::of(item.variant())}
                                rarity={&item.rarity}
                                quantity={item.quantity}
                                product_line={&item.product_line}
                                order={&item.order_quantity}
                                picture={item.catalog.as_ref().map(|c| picture(c.product_id, "400x400"))}
                                open={open}
                                detail={drawn.as_ref().map(|d| d as &dyn Render)}
                            />
                        }
                    </tbody>
                </table>
            </div>
            <p ref={empty} class={muted()} hidden={!items.is_empty()}>
                "No items match the filter."
            </p>
            <dialog ref={dialog} class={Picture}>
                <form method="dialog"><button aria-label="Close">"×"</button></form>
                <img ref={image} alt="">
            </dialog>
        </div>
    }
}
