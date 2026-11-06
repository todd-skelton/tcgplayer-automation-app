// corten ui 0.1.0: alert 1e1d8b3caad1a287
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
//! A form's own message (`errors.add_form(text)`) in the alert's look is `FormAlert`, the
//! destructive alert around the message's text, nothing when the form has none. Not
//! `errors.form_message()` inside an `Alert`: that paragraph is an alert of its own, and an alert
//! inside an alert may be read twice.
//!
//! ```rust,ignore
//! <form id={SellFormId} data-patch>
//!     <FormAlert errors={&errors} emphasis={AlertEmphasis::Soft} />
//!     ...
//! </form>
//! ```
//!
//! The text a script shows when a submit got no answer, `corten_ui::dialog::failed`'s `said`, in
//! the destructive alert's look is `FailedAlert`: a live region with no look of its own that
//! stays rendered, and inside it the alert, which is `said` and hidden until the script shows it.
//! Nothing shows before a failure, and no alert is inside another.
//!
//! ```rust,ignore
//! let said = refs();
//! <dialog on:connect={dialog::modal(target)} on:corten:error={dialog::failed(event, target, said)}>
//!     <FailedAlert said={said} emphasis={AlertEmphasis::Soft}>
//!         <p>{t.not_saved()}</p>
//!     </FailedAlert>
//!     ...
//! </dialog>
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

/// The text a script shows when a submit got no answer (`dialog::failed`'s `said`) in a
/// destructive alert: `said` is the alert, hidden until shown, inside a live region that stays
/// rendered and has no look, so showing it adds text to a region already there.
#[component(css = Alert)]
pub fn FailedAlert<C: Render>(
    said: Ref<el::HTMLDivElement>,
    emphasis: AlertEmphasis,
    children: C,
) -> impl Render {
    let emphasis = match emphasis {
        AlertEmphasis::Soft => Soft,
        AlertEmphasis::Outline => Outline,
        AlertEmphasis::Solid => Solid,
    };
    html! {
        <div role="alert">
            <div ref={said} class={(Alert, Destructive, emphasis)} hidden>{children}</div>
        </div>
    }
}

/// The form's own message (`Errors::add_form`) in a destructive alert, its one live region, or
/// nothing when the form has none: where `errors.form_message()` would go in the kit's look.
#[component]
pub fn FormAlert<'a>(errors: &'a Errors, emphasis: AlertEmphasis) -> impl Render {
    errors.form().map(|message| {
        html! {
            <Alert variant={AlertVariant::Destructive} emphasis={emphasis}><p>{message}</p></Alert>
        }
    })
}
