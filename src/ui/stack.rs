// corten ui 0.1.0: stack 589ac31f1c4a06b9
//! The space between a screen's parts, so no component carries an outer margin: `Stack` puts the
//! children of the element you write in a column and `Cluster` in a row that wraps, `gap` apart:
//!
//! ```rust,ignore
//! <form class={Stack { gap: Gap::Lg }} method="post" action={url::Settings}>..</form>
//! <div class={Cluster { gap: Gap::Sm }}><h2>"Orders"</h2><span class={Badge { .. }}>"10"</span></div>
//! ```
//!
//! Each child takes the stack's width, a button too: put one in a `Cluster` to keep it its own
//! size. The browser's default block margins on the children (a paragraph's, a heading's) are
//! dropped, so the gap is the space between them. The rule has no specificity: an app's rule that
//! names the element or a class (`static/style.css`'s `form { margin: .. }`) still sets its margin,
//! and only one with none (`*`, `:where(..)`) ties and loses to the kit's, linked after it. The gaps
//! are the values the kit's components space their own parts with. An app styled from its own token
//! utilities keeps its own scale with `Gap::App`, which sets no gap, beside its `gap` utility (the
//! styles guide), so the utility is the only gap and its screens follow its scale:
//!
//! ```rust,ignore
//! <div class={(Stack { gap: Gap::App }, gap_3())}>..</div>
//! ```
use corten::prelude::*;

/// The space between the children. Each but `App` is a class in `stack.css`, so one without a
/// rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gap {
    /// .25rem
    Xs,
    /// .5rem
    Sm,
    /// 1rem
    Md,
    /// 1.5rem
    Lg,
    /// 2rem
    Xl,
    /// None of the kit's: the app's own class sets it (its `gap` utility, `gap_3()`, or a rule of a
    /// stylesheet of its own), so a stack follows the app's scale. Without one the children touch.
    App,
}

/// A gap without a rule in `stack.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Stack() -> impl ClassList {
///     (Stack, Xxl)
/// }
/// ```
#[component(css)]
pub fn Stack(gap: Gap) -> impl ClassList {
    let gap = match gap {
        Gap::Xs => Some(Xs),
        Gap::Sm => Some(Sm),
        Gap::Md => Some(Md),
        Gap::Lg => Some(Lg),
        Gap::Xl => Some(Xl),
        Gap::App => None,
    };
    (Stack, gap)
}

/// A row of items, centered across it, that wraps onto the next line when it is full.
#[component(css = Stack)]
pub fn Cluster(gap: Gap) -> impl ClassList {
    let gap = match gap {
        Gap::Xs => Some(Xs),
        Gap::Sm => Some(Sm),
        Gap::Md => Some(Md),
        Gap::Lg => Some(Lg),
        Gap::Xl => Some(Xl),
        Gap::App => None,
    };
    (Cluster, gap)
}
