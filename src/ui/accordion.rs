// corten ui 0.1.0: accordion e5fdaad12b7dd820
//! Sections that open one at a time: the `<details>` written inside it, each with its
//! `<summary>`. A shared `name` makes them exclusive, and find-in-page opens the one that holds
//! the match, with no script:
//!
//! ```rust,ignore
//! <Accordion>
//!     <details name="faq" open><summary>"When do payouts go out?"</summary><p>"Every Friday."</p></details>
//!     <details name="faq"><summary>"What does it cost?"</summary><p>"Nothing to list."</p></details>
//! </Accordion>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Accordion() -> impl Render {
///     html! { <div class={(Accordion, Flush)}></div> }
/// }
/// ```
#[component(css)]
pub fn Accordion<C: Render>(children: C) -> impl Render {
    html! { <div class={Accordion}>{children}</div> }
}
