// corten ui 0.1.0: nav_bar cf81576a8235722b
//! The bar across the top of every page: the app's name, the links to its sections and actions at
//! the end, as the classes of the `<header>` and the elements you write in it. Write the links
//! with `req.nav`, `req.nav_section` or `req.nav_of`: they mark this page's link
//! `aria-current="page"`, which the runtime keeps right after a client navigation, and the bar
//! draws the current link from it.
//!
//! ```rust,ignore
//! <header class={NavBar {}}>
//!     <a class={NavBrand {}} href={url::Home}>"Seller desk"</a>
//!     <nav class={NavSections {}} aria-label="Sections">
//!         <a {..req.nav(&url::Inventory)}>"Inventory"</a>
//!         <a {..req.nav(&url::Statement)}>"Statement"</a>
//!     </nav>
//!     <div class={NavActions {}}>
//!         <a class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }} href={url::Account}>"Account"</a>
//!     </div>
//! </header>
//! ```
//!
//! On a phone (40rem and narrower) the links take a row of their own under the name and the
//! actions, the bar's width. When they are wider than the bar, the row scrolls sideways, with no
//! script: a shadow at an edge with more links past it, and a thin scrollbar for a mouse and under
//! forced colors (which drop the shadows); a touch screen, where the row is swiped, shows only the
//! shadows. Put the pages used most first: the current link is not scrolled into view, so one late
//! in a long row is drawn current out of sight. The keyboard still goes to the name, the links,
//! then the actions, so on a phone it reaches the actions drawn above the links after the links.
//! The bar does not fold its links into a menu, which would write them twice; an app that wants
//! one puts its links in a `Popover`.
//!
//! The bar is the theme's card colors, and every part of it is drawn from those two: the name and
//! the links in `--card-foreground`, the current link underlined in it, the focus rings and the
//! edge shadows from it. To recolor the bar (a brand-colored one), set `--card` and
//! `--card-foreground` in a class of yours on the `<header>`, a pair at least 4.5:1, not its
//! `background`: the links' shadows are covered in `--card` at their ends, so a background of
//! another color shows those covers as blocks. What else in the header reads `--card` takes the
//! bar's color too; a menu or popover there is drawn in `--popover`, as the kit's are. The actions
//! are the app's buttons, which keep their own colors: a `Ghost` or `Outline` `Button` reads the
//! page's `--foreground` and `--accent`, so on a recolored bar such a button takes a class of the
//! app's beside its look that sets `--foreground`, `--accent`, `--accent-foreground` and `--ring`
//! from the bar's pair, keeping `--accent` and `--accent-foreground` at least 4.5:1 (on a pair that
//! only just passes, swap the two on hover rather than mixing), and for an `Outline` one
//! `--background` (its fill, the bar's `--card`) and `--input` (its border) too. On the button itself, not the actions around it: a menu the
//! actions hold is drawn on `--popover` and keeps the page's colors.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn NavBar() -> impl ClassList {
///     (Bar, Sticky)
/// }
/// ```
#[component(css)]
pub fn NavBar() -> impl ClassList {
    Bar
}

/// The app's name or mark, usually a link home.
#[component(css = NavBar)]
pub fn NavBrand() -> impl ClassList {
    Brand
}

/// The `<nav>` of the section links: one row, scrolling sideways when it is wider than the bar.
#[component(css = NavBar)]
pub fn NavSections() -> impl ClassList {
    Sections
}

/// Buttons or links at the end of the bar (an account, a theme switch, signing out).
#[component(css = NavBar)]
pub fn NavActions() -> impl ClassList {
    Actions
}
