// corten ui 0.1.0: popover d331ee1e620d3573
//! Content that opens over the page next to the button that opened it: the platform's
//! `popover`, as the classes of the element you write, opened by `popovertarget` (or
//! `command="toggle-popover"` with `commandfor`) with no script. A click outside or Escape
//! closes it.
//!
//! ```rust,ignore
//! <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }} type="button" popovertarget={ShareId}>"Share"</button>
//! <div class={Popover {}} id={ShareId} popover>..</div>
//! ```
//!
//! Where the browser has anchor positioning, it sits under the button (above it when there is no
//! room); elsewhere, in the middle of the window.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Popover() -> impl ClassList {
///     (Popover, Arrow)
/// }
/// ```
#[component(css)]
pub fn Popover() -> impl ClassList {
    Popover
}
