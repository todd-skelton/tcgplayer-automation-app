use corten::prelude::*;
use serde::Deserialize;

use super::{ItemCard, ItemRow, SortBy, picture};
use crate::{
    features::pull_sheet::{
        items::{Grade, Item, Printing},
        url::{self, SheetQuery},
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

/// A sheet: its summary, the filter, and its items as picture cards or a table. The filter and
/// the table's sort run in the browser over both lists (each a list of views, so a handler reads
/// a row's fields by name); without JavaScript the filter is a GET form and the column headers
/// are links the server sorts by.
#[component(css, js)]
pub fn SheetScreen<'a>(
    id: i64,
    file_name: &'a str,
    summary: &'a Summary,
    items: &'a [Item],
    filters: &'a SheetQuery,
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
    let q = filters.q.as_deref().unwrap_or("");
    let (f, l) = (SheetQuery::FIELDS, ShowAs::FIELDS);
    let sorted = |by: SortBy| url::PullSheet {
        id,
        filters: SheetQuery {
            q: filters.q.clone(),
            sort: Some(by),
        },
    };
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
        <section>
            <h1>"Pull Sheet"</h1>
            <div class={(panel(), mb_4(), Toolbar)}>
                <span class={muted()}>{file_name}</span>
                <a href={url::PullSheets}>"Upload another"</a>
                <form
                    method="get"
                    action={url::PullSheet { id, filters: SheetQuery::default() }}
                    class={(row(Space::_2), Filter)}
                >
                    <input
                        type="search"
                        name={f.q}
                        value={q}
                        placeholder="Filter items..."
                        aria-label="Filter items"
                        on:input={js::filter(target, found)}
                    >
                    if let Some(sort) = filters.sort {
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
                    <ItemCard key={key} search={&item.search_text()} item={item} />
                }
            </div>
            <div class={TableBox}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th><span class={Hidden}>"Picture"</span></th>
                            for (by, label) in columns {
                                <th aria-sort={(filters.sort == Some(by)).then_some("ascending")}>
                                    <a
                                        href={sorted(by)}
                                        on:click={js::sortBy(event, target, found, by)}
                                    >
                                        {label}
                                    </a>
                                </th>
                            }
                            <th>"Order"</th>
                        </tr>
                    </thead>
                    <tbody
                        ref={rows}
                        on:click={js::showPicture(event, open.closest(), dialog, image)}
                    >
                        for (key, item) in items.iter().enumerate() {
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
        </section>
    }
}
