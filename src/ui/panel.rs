//! A raised surface around one block of content, as the classes of the element you write (a
//! `<section>`, a `<form>`, an element a patch replaces): the kit Card's surface (its
//! background, border, corners and shadow) with room inside, and no layout of its own, so the
//! element's own class lays out what is in it. The kit's `Card` lays out its parts (a column with
//! gaps), which is for a card with a header, content and footer; a panel has none (corten#605).
//!
//! ```rust,ignore
//! <section class={(Panel {}, Settings)} aria-labelledby={SettingsTitle}>..</section>
//! ```
use corten::prelude::*;

#[component(css)]
pub fn Panel() -> impl ClassList {
    Panel
}
