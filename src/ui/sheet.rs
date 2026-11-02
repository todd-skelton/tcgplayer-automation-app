// corten ui 0.1.0: sheet c30086c58719386d
//! A dialog that slides in from an edge of the window: a menu, filters, a record beside its list.
//! It is the classes of the `<dialog>` you write, as `Dialog` is, opened by
//! `command="show-modal" commandfor={FiltersId}`:
//!
//! ```rust,ignore
//! <dialog class={Sheet { side: Side::Right }} id={FiltersId} closedby="any"><h2>"Filters"</h2>..</dialog>
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
/// fn Sheet() -> impl ClassList {
///     (Sheet, Center)
/// }
/// ```
#[component(css)]
pub fn Sheet(side: Side) -> impl ClassList {
    let side = match side {
        Side::Top => Top,
        Side::Right => Right,
        Side::Bottom => Bottom,
        Side::Left => Left,
    };
    (Sheet, side)
}
