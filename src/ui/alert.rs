// corten ui 0.1.0: alert 0993adacb6dc4d44
//! A message the page calls out. Its heading and text are yours (`<h2>` to `<h6>` or `<strong>`,
//! then `<p>`). Its role follows its variant, so a screen reader interrupts the user only for what
//! needs them now: `Destructive` and `Warning` are `role="alert"` (read at once when a patch
//! brings one in, as a form's error is), `Success` is `role="status"` (read politely, though a
//! status brought in with its text is not read by every screen reader; the result of an action is
//! a toast, corten-ui's `Toaster`), and `Neutral` and `Info` have no role and are read in the
//! page's order. Its emphasis is separate from its variant, as a `Badge`'s is: a tint of the tone
//! behind text in it (`Soft`), the tone's text on the card inside its border (`Outline`), or filled
//! with the tone (`Solid`). The text of each meets WCAG AA in both themes (the kit's test).
//!
//! ```rust,ignore
//! <Alert variant={AlertVariant::Destructive} emphasis={AlertEmphasis::Soft}>
//!     <strong>"Payment failed"</strong>
//!     <p>"Your card was declined."</p>
//! </Alert>
//! ```
//!
//! An app whose alerts all have one emphasis gives it once, in a component of its own:
//!
//! ```rust,ignore
//! #[component]
//! pub fn Notice<C: Render>(variant: AlertVariant, children: C) -> impl Render {
//!     html! { <Alert variant={variant} emphasis={AlertEmphasis::Soft}>{children}</Alert> }
//! }
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

/// How much the alert stands out: a tint of its tone, an outline on the card, or filled with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertEmphasis {
    Soft,
    Outline,
    Solid,
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
pub fn Alert<C: Render>(
    variant: AlertVariant,
    emphasis: AlertEmphasis,
    children: C,
) -> impl Render {
    let (variant, role) = match variant {
        AlertVariant::Neutral => (Neutral, None),
        AlertVariant::Info => (Info, None),
        AlertVariant::Success => (Success, Some("status")),
        AlertVariant::Warning => (Warning, Some("alert")),
        AlertVariant::Destructive => (Destructive, Some("alert")),
    };
    let emphasis = match emphasis {
        AlertEmphasis::Soft => Soft,
        AlertEmphasis::Outline => Outline,
        AlertEmphasis::Solid => Solid,
    };
    html! { <div class={(Alert, variant, emphasis)} role={role}>{children}</div> }
}
