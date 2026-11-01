// corten ui 0.1.0: sheet bcb10dcfd60d80ac
//! A dialog that slides in from an edge of the window: a menu, filters, a record beside its list.
//! It is a `<dialog>` written inside it, as for `Dialog`, opened by
//! `command="show-modal" commandfor={FiltersId}`:
//!
//! ```rust,ignore
//! <Sheet side={Side::Right}>
//!     <dialog id={FiltersId} closedby="any"><h2>"Filters"</h2>..</dialog>
//! </Sheet>
//! ```
use corten::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

/// A side without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Sheet() -> impl Render {
///     html! { <div class={(Sheet, Center)}></div> }
/// }
/// ```
#[component(css)]
pub fn Sheet<C: Render>(side: Side, children: C) -> impl Render {
    let side = match side {
        Side::Top => Top,
        Side::Right => Right,
        Side::Bottom => Bottom,
        Side::Left => Left,
    };
    html! { <div class={(Sheet, side)}>{children}</div> }
}
