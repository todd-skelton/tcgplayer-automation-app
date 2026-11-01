// corten ui 0.1.0: toasts 46bb3ad626fcb77a
//! The look and place of corten-ui's `Toaster` written inside it: a box at the bottom right of
//! the window while there is a message, with its close button. The app lists
//! `corten_ui::COMPONENTS` too, and puts it in the layout once:
//!
//! ```rust,ignore
//! <Toasts><Toaster close={t.dismiss()} seconds={5} toast={Toast { message: req.notice() }} /></Toasts>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Toasts() -> impl Render {
///     html! { <div class={(Toasts, Top)}></div> }
/// }
/// ```
#[component(css)]
pub fn Toasts<C: Render>(children: C) -> impl Render {
    html! { <div class={Toasts}>{children}</div> }
}
