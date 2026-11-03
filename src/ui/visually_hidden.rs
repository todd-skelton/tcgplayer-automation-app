// corten ui 0.1.0: visually_hidden 62d1f0b626959fae
//! Text a screen reader reads and the page does not draw, as the class of the element you write:
//! the name of an icon control whose element the kit draws (a `MenuButton`'s trigger takes markup,
//! not attributes; a `<button>` you write takes `aria-label`), a legend a layout does not need to
//! show, a busy region's words.
//!
//! ```rust,ignore
//! <DropdownMenu trigger={MenuTrigger::Icon}>
//!     <MenuButton
//!         id={RowMenuId(&row.reference)}
//!         label={html! {
//!             <Icon glyph={icon::ELLIPSIS_VERTICAL} />
//!             <span class={VisuallyHidden {}}>"More actions for "{&row.reference}</span>
//!         }}
//!     >
//!         ..
//!     </MenuButton>
//! </DropdownMenu>
//! ```
//!
//! (`Icon` is the kit's, `corten ui add icon`.) Text no one should read is `hidden`, and a mark
//! that only decorates is `aria-hidden="true"`.
//!
//! It is placed out of the flow, against the nearest positioned element around it, so a box of
//! the app's that scrolls sideways around it (`overflow-x: auto`) is positioned
//! (`position: relative`), or the text can sit past the page's edge and widen the page. The kit's
//! `Table` and `NavBar` links are.
use corten::prelude::*;

/// A part without a rule in `visually_hidden.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn VisuallyHidden() -> impl ClassList {
///     (VisuallyHidden, Focusable)
/// }
/// ```
#[component(css)]
pub fn VisuallyHidden() -> impl ClassList {
    VisuallyHidden
}
