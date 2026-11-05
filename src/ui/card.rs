// corten ui 0.1.0: card 1d594a58a40129bc
//! A surface that groups related content, as the classes of the element you write: a `<section>`
//! with a label, an `<article>`, an `<li>`, a `<form>`, an element a patch replaces by its id. The
//! heading inside the header is yours, so the page keeps its outline (`<h2>` or `<h3>` as the page
//! needs), and a `<p>` after it is the description:
//!
//! ```rust,ignore
//! <section class={Card {}} aria-labelledby={PayoutsTitle}>
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
//! `<section class={CardPanel {}} aria-labelledby={RatesTitle}>..</section>`. A panel is the
//! surface and its padding only, so the element's own class lays it out (a row of filters,
//! `class={(CardPanel {}, Filters)}`), or a `Stack` does. `CardCompact` beside either makes it
//! denser, for a page with dense and roomy cards: `class={(Card {}, CardCompact {})}`; a theme
//! sets every card's padding with `--card-padding`.
use corten::prelude::*;

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
pub fn Card() -> impl ClassList {
    Card
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
pub fn CardPanel() -> impl ClassList {
    Panel
}

/// Beside `Card {}` or `CardPanel {}`: less padding and a smaller gap, for one card on a page.
#[component(css = Card)]
pub fn CardCompact() -> impl ClassList {
    Compact
}

#[component(css = Card)]
pub fn CardContent() -> impl ClassList {
    Content
}

#[component(css = Card)]
pub fn CardFooter() -> impl ClassList {
    Footer
}
