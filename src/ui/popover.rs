// corten ui 0.1.0: popover 911da49c3fb9576e
//! Content that opens over the page next to the button that opened it: the platform's
//! `popover`, written inside it, opened by `popovertarget` (or `command="toggle-popover"`
//! with `commandfor`) with no script. A click outside or Escape closes it.
//!
//! ```rust,ignore
//! <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
//!     <button type="button" popovertarget={ShareId}>"Share"</button>
//! </Button>
//! <Popover><div id={ShareId} popover>..</div></Popover>
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
/// fn Popover() -> impl Render {
///     html! { <div class={(Popover, Arrow)}></div> }
/// }
/// ```
#[component(css)]
pub fn Popover<C: Render>(children: C) -> impl Render {
    html! { <div class={Popover}>{children}</div> }
}
