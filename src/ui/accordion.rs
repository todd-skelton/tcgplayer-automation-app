// corten ui 0.1.0: accordion 02e33401f3f502b8
//! Sections that open one at a time: the classes of each `<details>` you write, with its
//! `<summary>`. A shared `name` makes them exclusive, and find-in-page opens the one that holds
//! the match, with no script:
//!
//! ```rust,ignore
//! <details class={Accordion {}} name="faq" open><summary>"When do payouts go out?"</summary><p>"Every Friday."</p></details>
//! <details class={Accordion {}} name="faq"><summary>"What does it cost?"</summary><p>"Nothing to list."</p></details>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Accordion() -> impl ClassList {
///     (Accordion, Flush)
/// }
/// ```
#[component(css)]
pub fn Accordion() -> impl ClassList {
    Accordion
}
