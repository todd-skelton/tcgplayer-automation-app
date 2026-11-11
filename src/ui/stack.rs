// corten ui 0.1.0: stack f45d71bb9d9b23ad
//! The space between a screen's parts, so no component carries an outer margin: `Stack` puts the
//! children of the element you write in a column and `Cluster` in a row that wraps, `gap` apart:
//!
//! ```rust,ignore
//! <form class={Stack { gap: Gap::Lg }} method="post" action={url::Settings}>..</form>
//! <div class={Cluster { gap: Gap::Sm }}><h2>"Orders"</h2><span class={Badge { .. }}>"10"</span></div>
//! ```
//!
//! Each child takes the stack's width, a button too. A column whose children keep their own width
//! (a link as wide as its words, a badge, a button under a line of text) is a `StackStart` in place
//! of the `Stack`, with the same `gap`: each child is at most the column's width, so a long link
//! wraps, a word wider than the column breaks inside it and a picture narrows in its shape; one
//! button alone in a row is a `Cluster` too. The browser's default block margins on the children (a
//! paragraph's, a heading's) are dropped, so the gap is the space between them; a `<dialog>` or
//! `[popover]` child keeps its `margin: auto` and width, so a modal written beside its button still
//! opens centered. The rule has no specificity: an app's rule that names the element or a class
//! (`static/style.css`'s `form { margin: .. }`) still sets its margin, and only one with none (`*`,
//! `:where(..)`) ties and loses to the kit's, linked after it. The gaps are the values the kit's
//! components space their own parts with. An app styled from its own token utilities keeps its own
//! scale with `Gap::App`, which sets no gap, beside its `gap` utility (the styles guide), so the
//! utility is the only gap and its screens follow its scale:
//!
//! ```rust,ignore
//! <div class={(Stack { gap: Gap::App }, gap_3())}>..</div>
//! <div class={StackStart { gap: Gap::Xs }}><a href={url::Help}>"How limits work"</a>..</div>
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

/// A `Stack` whose children keep their own width, at the start of the column, each at most the
/// column's (a word wider than that breaks inside it, a picture keeps its shape). It is the stack
/// itself, its classes and `gap` included, so it is written in place of a `Stack`, not beside a
/// `Stack` or a `Cluster`: beside a `Stack` it writes the stack's classes twice (and both gaps
/// when they differ, the larger winning), and beside a `Cluster` it turns the row into a column.
/// With `Gap::App` it takes the app's `gap` utility beside it, as `Stack` does. Its rule names
/// both classes, so it wins over the stack's wherever the app links its stylesheets.
#[component(css = Stack)]
pub fn StackStart(gap: Gap) -> impl ClassList {
    // `self::Stack` is the component; `Stack` alone, here, is its class.
    (self::Stack { gap }, Start)
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
