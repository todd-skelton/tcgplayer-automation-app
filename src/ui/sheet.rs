// corten ui 0.1.0: sheet 77c6463353250107
//! A dialog that slides in from an edge of the window: a menu, filters, a record beside its list.
//! It is the classes of the `<dialog>` you write, as `Dialog` is, opened by
//! `command="show-modal" commandfor={FiltersId}`:
//!
//! ```rust,ignore
//! <dialog class={Sheet { side: Side::Right(SheetWidth::Md) }} id={FiltersId} closedby="any">
//!     <div class={SheetHeader {}}>
//!         <h2>"Filters"</h2>
//!         <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }} type="button" command="close" commandfor={FiltersId}>"Close"</button>
//!     </div>
//!     ..
//! </dialog>
//! ```
//!
//! A sheet longer than the window scrolls, its `SheetHeader` (its first element, as a dialog's)
//! held at the top.
use corten::prelude::*;

/// The edge it slides in from. A side sheet has a width; one across the top or bottom is as wide
/// as the window, so it has none to give.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Right(SheetWidth),
    Bottom,
    Left(SheetWidth),
}

/// A side sheet's width, never more than 85% of the window. Each is a class in `sheet.css`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetWidth {
    /// 20rem: a menu.
    Sm,
    /// 24rem: filters.
    Md,
    /// 32rem: a record beside its list, a long form.
    Lg,
    /// 40rem.
    Xl,
}

/// A side without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Sheet() -> impl ClassList {
///     (Sheet, Center)
/// }
/// ```
#[component(css)]
pub fn Sheet(side: Side) -> impl ClassList {
    let width = |width| match width {
        SheetWidth::Sm => Sm,
        SheetWidth::Md => Md,
        SheetWidth::Lg => Lg,
        SheetWidth::Xl => Xl,
    };
    let (side, width) = match side {
        Side::Top => (Top, None),
        Side::Right(w) => (Right, Some(width(w))),
        Side::Bottom => (Bottom, None),
        Side::Left(w) => (Left, Some(width(w))),
    };
    (Sheet, side, width)
}

/// The sheet's heading and the controls at its end, on the app's `<div>`, its first element (not a
/// `<header>`, which outside a section is the page's banner landmark).
#[component(css = Sheet)]
pub fn SheetHeader() -> impl ClassList {
    Header
}
