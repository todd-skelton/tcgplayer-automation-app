// corten ui 0.1.0: table 05a34544d9cc8c8c
//! A table's look, on the `<table>` written inside it: the rows, headers and caption stay the
//! app's markup. `layout` is `TableLayout::Scroll` for a table that keeps its columns: the wrapper
//! scrolls sideways when the table is wider than the page, so it is a box of its own.
//! `TableLayout::Stack` is for a table read one row at a time (an account, an order): on a phone
//! (below the theme's `wide`), each row is a block of its cells, one per line, each led by
//! its column's name from the `CellLabel` in it, with the rest of the cell beside it, where text
//! wraps and each element starts a line (wrap text and an element in one `<span>` to keep them
//! on one); a row header (`<th scope="row">`) is laid out the same, and a cell without a
//! `CellLabel` is a block of its content. The column headers are drawn as a row when they hold a
//! link or a button (a `SortHeader`), so the table still sorts by touch, and are hidden otherwise.
//! It stays a table to a screen reader, which names each cell's column from the headers, so a
//! `CellLabel` is hidden from it. Cells wrap as text does and headers stay on one line; a number
//! column takes the `TableNumeric` look (aligned to its end, tabular figures, on one line), and
//! a column the table sorts by has a `SortHeader`. The kit's cell rules have no specificity
//! (`:where`), so one class of the app's on a cell wins.
//!
//! ```rust,ignore
//! <Table layout={TableLayout::Scroll}>
//!     <table>
//!         <caption>"Recent orders"</caption>
//!         <thead>
//!             <tr>
//!                 <th scope="col">"Buyer"</th>
//!                 <SortHeader
//!                     label="Total"
//!                     sort={None}
//!                     link={&url::Orders { sort: Some(By::Total) }}
//!                     class={TableNumeric {}}
//!                     on:sort={None::<Handler>}
//!                 />
//!             </tr>
//!         </thead>
//!         <tbody>.. <td class={TableNumeric {}}>{total}</td> ..</tbody>
//!     </table>
//! </Table>
//! ```
//!
//! A stacked table names each cell's column in it:
//!
//! ```rust,ignore
//! <Table layout={TableLayout::Stack}>
//!     <table>
//!         <thead><tr><th scope="col">"Buyer"</th>..</tr></thead>
//!         <tbody>.. <td><CellLabel>"Buyer"</CellLabel>{buyer}</td> ..</tbody>
//!     </table>
//! </Table>
//! ```
use corten::Href;
use corten::prelude::*;

/// How a table fits a box narrower than it. Each is a class in `table.css`, so one without a rule
/// does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableLayout {
    /// Columns at every width; the wrapper scrolls sideways.
    Scroll,
    /// On a phone, each row a block of labelled cells; elsewhere as `Scroll`.
    Stack,
}

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Table() -> impl Render {
///     html! { <div class={(Table, Striped)}></div> }
/// }
/// ```
#[component(css)]
pub fn Table<C: Render>(layout: TableLayout, children: C) -> impl Render {
    let layout = match layout {
        TableLayout::Scroll => None,
        TableLayout::Stack => Some(Stacked),
    };
    html! { <div class={(Table, layout)}>{children}</div> }
}

/// A cell's column name, shown before its value when a `TableLayout::Stack` table is stacked and
/// hidden otherwise; a screen reader skips it, since the table's headers name the column.
#[component(css = Table)]
pub fn CellLabel<C: Render>(children: C) -> impl Render {
    html! { <span class={Label} aria-hidden="true">{children}</span> }
}

/// A number column's cells and header: aligned to the end, so digits line up, in tabular figures,
/// on one line.
#[component(css = Table)]
pub fn TableNumeric() -> impl ClassList {
    Numeric
}

/// The order a column is sorted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    Ascending,
    Descending,
}

/// A column header the table can be sorted by: a link to the page sorted by it (a typed route,
/// with the order the app chooses for a second click), so it works without a script, and
/// `aria-sort` on the column the table is sorted by now (`sort`, `None` for the others). The
/// direction is drawn, not written, so a screen reader reads the label and the column's sort
/// state, not an arrow's name: the arrow is drawn from the header's `aria-sort`, so it follows
/// the one state both the server and a script write. `class` is the header's look (`TableNumeric
/// {}` over a number column, `()` for none). `on:sort` is the link's click handler:
/// `None::<Handler>` for a table the server sorts, or, on a page that has every row and sorts them
/// in place without a request (with `data-no-prefetch` on the `<thead>`, so a hover does not fetch
/// the sorted page), `corten_ui::rows::sort(event, target)`, which sorts by the header's column,
/// each cell by its `data-sort`, `<time datetime>`, `<data value>` or text (docs/guide/ui.md), or
/// the page's own typed call
/// (`on:sort={js::sortBy(event, target, rows, By::Total)}`). Such a script takes the click as an
/// `Event` (a prop's handler gets that type), leaves a click with a modifier key to the link, so it
/// still opens or saves the sorted page (`event.ctrlKey`, `metaKey`, `shiftKey` or `altKey` on a
/// `MouseEvent`), otherwise calls `event.preventDefault()`, sorts, and sets `aria-sort` on the
/// header it sorted by and removes it from the others. The link still sorts a page loaded without
/// the script.
#[component(css = Table)]
pub fn SortHeader<'a, L: Render, C: ClassList>(
    label: L,
    sort: Option<Sort>,
    link: &'a dyn Href,
    class: C,
    on_sort: Handler<'a>,
) -> impl Render {
    let aria = match sort {
        Some(Sort::Ascending) => Some("ascending"),
        Some(Sort::Descending) => Some("descending"),
        None => None,
    };
    html! {
        <th scope="col" class={class} aria-sort={aria}>
            <a class={Sorter} href={link} on:click={on_sort}>
                {label}<span class={Arrow} aria-hidden="true"></span>
            </a>
        </th>
    }
}
