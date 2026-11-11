// corten ui 0.1.0: card 24ef90ff3e9a180d
//! A surface that groups related content, as the classes of the element you write: a `<section>`
//! with a label, an `<article>`, an `<li>`, a `<form>`, an element a patch replaces by its id. The
//! heading inside the header is yours, so the page keeps its outline (`<h2>` or `<h3>` as the page
//! needs), and a `<p>` after it is the description:
//!
//! ```rust,ignore
//! <section class={Card { size: CardSize::Md }} aria-labelledby={PayoutsTitle}>
//!     <header class={CardHeader {}}>
//!         <h2 id={PayoutsTitle}>"Payouts"</h2>
//!         <div class={CardAction {}}><a href={url::Payouts}>"All payouts"</a></div>
//!         <p>"Sent every Friday."</p>
//!     </header>
//!     <div class={CardContent {}}>..</div>
//!     <footer class={CardFooter {}}>..</footer>
//! </section>
//! ```
//!
//! A card around one block of content, with no header or footer, is one element, a `CardPanel`
//! (not `Card` and `CardContent` together, whose rules are for two elements):
//! `<section class={CardPanel { size: CardSize::Md }} aria-labelledby={RatesTitle}>..</section>`. A
//! panel is the surface and its padding only, so the element's own class lays it out (a row of
//! filters, `class={(CardPanel { size: CardSize::Md }, Filters)}`), or a `Stack` does.
//! `CardSize::Sm` makes either denser, for a page with dense and roomy cards:
//! `class={Card { size: CardSize::Sm }}`; a theme sets every card's padding with `--card-padding`,
//! a dense one's following it.
use corten::prelude::*;

/// A card's or a panel's padding and the gap between its parts. `Md` writes no class; `Sm` is a class
/// in `card.css`, so a size without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardSize {
    /// The theme's `--card-padding`.
    Md,
    /// Padding and a gap between its parts two thirds of the theme's `--card-padding`, and a gap in
    /// its content half of it, for a dense card on a page with roomy ones.
    Sm,
}

/// A part without a rule in `card.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Card() -> impl ClassList {
///     Banner
/// }
/// ```
#[component(css)]
pub fn Card(size: CardSize) -> impl ClassList {
    let size = match size {
        CardSize::Md => None,
        CardSize::Sm => Some(Sm),
    };
    (Card, size)
}

#[component(css = Card)]
pub fn CardHeader() -> impl ClassList {
    Header
}

/// Controls at the end of the header's heading row (a link, a button, a menu), written after the
/// heading; they wrap under it when the row has no room.
#[component(css = Card)]
pub fn CardAction() -> impl ClassList {
    Action
}

/// A card around one block of content, on one element: the card's surface and its padding on every
/// side, and no layout, so the element's own class or a `Stack` lays its children out.
#[component(css = Card)]
pub fn CardPanel(size: CardSize) -> impl ClassList {
    let size = match size {
        CardSize::Md => None,
        CardSize::Sm => Some(Sm),
    };
    (Panel, size)
}

#[component(css = Card)]
pub fn CardContent() -> impl ClassList {
    Content
}

#[component(css = Card)]
pub fn CardFooter() -> impl ClassList {
    Footer
}
