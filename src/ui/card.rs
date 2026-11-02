// corten ui 0.1.0: card 6ec2b2eb7c699680
//! A surface that groups related content, as the classes of the element you write: a `<section>`
//! with a label, an `<article>`, an `<li>`, a `<form>`, an element a patch replaces by its id. The
//! heading inside the header is yours, so the page keeps its outline (`<h2>` or `<h3>` as the page
//! needs), and a `<p>` after it is the description:
//!
//! ```rust,ignore
//! <section class={Card {}} aria-labelledby={PayoutsTitle}>
//!     <header class={CardHeader {}}><h2 id={PayoutsTitle}>"Payouts"</h2><p>"Sent every Friday."</p></header>
//!     <div class={CardContent {}}>..</div>
//!     <footer class={CardFooter {}}>..</footer>
//! </section>
//! ```
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

#[component(css = Card)]
pub fn CardContent() -> impl ClassList {
    Content
}

#[component(css = Card)]
pub fn CardFooter() -> impl ClassList {
    Footer
}
