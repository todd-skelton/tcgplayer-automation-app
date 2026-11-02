// corten ui 0.1.0: alert 41896e4e4ecfb62c
//! A message the page calls out. Its heading and text are yours (`<h2>` to `<h6>` or `<strong>`,
//! then `<p>`). Its role follows its variant, so a screen reader interrupts the user only for what
//! needs them now: `Destructive` and `Warning` are `role="alert"` (read at once when a patch
//! brings one in, as a form's error is), `Success` is `role="status"` (read politely, though a
//! status brought in with its text is not read by every screen reader; the result of an action is
//! a toast, corten-ui's `Toaster`), and `Neutral` and `Info` have no role and are read in the
//! page's order.
//!
//! ```rust,ignore
//! <Alert variant={AlertVariant::Destructive}>
//!     <strong>"Payment failed"</strong>
//!     <p>"Your card was declined."</p>
//! </Alert>
//! ```
use corten::prelude::*;

/// Each variant is a class in `alert.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertVariant {
    Neutral,
    Info,
    Success,
    Warning,
    Destructive,
}

/// A variant without a rule in `alert.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Alert() -> impl Render {
///     html! { <div class={(Alert, Urgent)}></div> }
/// }
/// ```
#[component(css)]
pub fn Alert<C: Render>(variant: AlertVariant, children: C) -> impl Render {
    let (variant, role) = match variant {
        AlertVariant::Neutral => (Neutral, None),
        AlertVariant::Info => (Info, None),
        AlertVariant::Success => (Success, Some("status")),
        AlertVariant::Warning => (Warning, Some("alert")),
        AlertVariant::Destructive => (Destructive, Some("alert")),
    };
    html! { <div class={(Alert, variant)} role={role}>{children}</div> }
}
