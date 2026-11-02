// corten ui 0.1.0: table 8e246a16a3710ae2
//! A table's look, on the `<table>` written inside it: the rows, headers and caption stay the
//! app's markup. The wrapper scrolls sideways when the table is wider than the page, so it is a box
//! of its own. Cells wrap as text does and headers stay on one line; a number column takes the
//! `TableNumeric` look (aligned to its end, tabular figures, on one line), and a column the table
//! sorts by has a `SortHeader`. The kit's cell rules have no specificity (`:where`), so one class
//! of the app's on a cell wins.
//!
//! ```rust,ignore
//! <Table>
//!     <table>
//!         <caption>"Recent orders"</caption>
//!         <thead>
//!             <tr>
//!                 <th scope="col">"Buyer"</th>
//!                 <SortHeader label="Total" sort={None} link={&url::Orders { sort: Some(By::Total) }} class={TableNumeric {}} />
//!             </tr>
//!         </thead>
//!         <tbody>.. <td class={TableNumeric {}}>{total}</td> ..</tbody>
//!     </table>
//! </Table>
//! ```
use corten::Href;
use corten::prelude::*;

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
pub fn Table<C: Render>(children: C) -> impl Render {
    html! { <div class={Table}>{children}</div> }
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
/// the one state both the server and a script write. `class` is the header's look
/// (`TableNumeric {}` over a number column, `()` for none). A page that sorts its rows in place
/// without a request handles the links' clicks once, on the `<table>` (`on:click`, with
/// `event.target.closest("a")`), sets `aria-sort` on the header it sorted by and removes it from
/// the others; the link still sorts a page loaded without the script.
#[component(css = Table)]
pub fn SortHeader<'a, L: Render, C: ClassList>(
    label: L,
    sort: Option<Sort>,
    link: &'a dyn Href,
    class: C,
) -> impl Render {
    let aria = match sort {
        Some(Sort::Ascending) => Some("ascending"),
        Some(Sort::Descending) => Some("descending"),
        None => None,
    };
    html! {
        <th scope="col" class={class} aria-sort={aria}>
            <a class={Sorter} href={link}>{label}<span class={Arrow} aria-hidden="true"></span></a>
        </th>
    }
}
