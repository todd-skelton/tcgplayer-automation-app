use corten::{Href, form::keep_query, prelude::*};

use super::{ItemCard, ItemRow, SortBy, picture};
use crate::{
    features::pull_sheet::{
        items::{Grade, Item, Printing},
        url::SheetQuery,
    },
    text::Msg,
    theme::*,
    ui::{
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        dialog::{Dialog, DialogHeader, DialogSize},
        input::Input,
        segmented::{Legend, SegmentedRadio, SegmentedRadios},
        table::{Sort, SortHeader, Table, TableLayout, TableNumeric},
        visually_hidden::VisuallyHidden,
    },
};

/// The picture dialog's heading.
#[derive(Id)]
struct PictureHeadingId;

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
#[derive(Fields)]
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
    /// The sheet as shown: the filter form's action, whose query (its sort, and the shipping
    /// step it is drawn on) the filter keeps.
    pub here: &'a dyn Href,
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
            <div class={(CardPanel {}, CardCompact {}, mb_4(), Toolbar)}>
                {lead}
                <form method="get" action={paging.here} class={(row(Space::_2), Filter)}>
                    {keep_query(paging.here, html! {
                        <input class={Input {}}
                            type="search"
                            name={f.q}
                            value={q}
                            placeholder="Filter items..."
                            aria-label="Filter items"
                            on:input={js::filter(target, found)}
                        >
                        <button class={NoScript}>"Filter"</button>
                    })}
                </form>
                <SegmentedRadios legend={Legend::Hidden("Show as")}>
                    <SegmentedRadio label="Grid">
                        <input type="radio" name={l.layout} value="grid" class={GridChoice} checked>
                    </SegmentedRadio>
                    <SegmentedRadio label="Table">
                        <input type="radio" name={l.layout} value="table" class={TableChoice}>
                    </SegmentedRadio>
                </SegmentedRadios>
            </div>
            <div class={(row(Space::_2), mb_4())}>
                <span class={Badge { tone: BadgeTone::Primary, emphasis: BadgeEmphasis::Soft }}>
                    {summary.items}" items"
                </span>
                <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                    {summary.quantity}" total qty"
                </span>
                if summary.not_found > 0 {
                    <span
                        class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Outline }}
                    >
                        {summary.not_found}" not in database"
                    </span>
                }
                if summary.orders > 0 {
                    <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Outline }}>
                        {summary.orders}" orders"
                    </span>
                }
                <output
                    ref={shown}
                    class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Outline }}
                    hidden={q.is_empty()}
                >
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
                <Table layout={TableLayout::Scroll}>
                    <table>
                        <thead>
                            <tr>
                                <th><span class={VisuallyHidden {}}>"Picture"</span></th>
                                for (by, label) in columns {
                                    <SortHeader
                                        label={label}
                                        sort={(paging.filters.sort == Some(by)).then_some(Sort::Ascending)}
                                        // Each column sorts one way, so both orders are its link.
                                        ascending={&*(paging.link)(by)}
                                        descending={&*(paging.link)(by)}
                                        first={Sort::Ascending}
                                        class={(by == SortBy::Quantity).then_some(TableNumeric {})}
                                        on:sort={js::sortBy(event, target, found, by)}
                                    />
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
                </Table>
            </div>
            <p ref={empty} class={muted()} hidden={!items.is_empty()}>
                "No items match the filter."
            </p>
            <dialog
                ref={dialog}
                class={(Dialog { size: DialogSize::Lg }, Picture)}
                aria-labelledby={PictureHeadingId}
            >
                <div class={DialogHeader {}}>
                    <h2 id={PictureHeadingId}>"Picture"</h2>
                    <form method="dialog">
                        <button
                            class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                        >
                            "Close"
                        </button>
                    </form>
                </div>
                <img ref={image} alt="">
            </dialog>
        </div>
    }
}
