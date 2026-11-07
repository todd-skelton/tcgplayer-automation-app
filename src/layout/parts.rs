//! Pieces screens draw the same way: a notice, a form's own message, a dialog's word that a submit
//! got no answer, and a form sent on change. A labeled field is the
//! kit's `ui::field::Field`.
use corten::prelude::*;

use crate::{
    layout::NOT_SENT,
    ui::alert::{Alert, AlertEmphasis, AlertVariant, FailedAlert, FormAlert},
};

/// A message a screen calls out: the kit's `Alert` with a tint of its tone behind its text, as
/// MUI's standard `Alert` drew every one in the React app.
#[component]
pub fn Notice<C: Render>(variant: AlertVariant, children: C) -> impl Render {
    html! { <Alert variant={variant} emphasis={AlertEmphasis::Soft}>{children}</Alert> }
}

/// The form's own message (`Errors::add_form`) as a destructive `Notice`, as the React screens
/// drew a refused save in an error `Alert`; nothing when the form has none.
#[component]
pub fn FormNotice<'a>(errors: &'a Errors) -> impl Render {
    html! { <FormAlert errors={errors} emphasis={AlertEmphasis::Soft} /> }
}

/// What a modal dialog says when a `data-patch` submit in it got no answer, in place of the
/// page's toaster, which the dialog covers: the toaster's words in the kit's `FailedAlert`, tinted
/// as every `Notice` is, hidden until `corten_ui::dialog::failed(event, target, said)` shows them.
#[component]
pub fn DialogNotSent(said: Ref<el::HTMLDivElement>) -> impl Render {
    html! {
        <FailedAlert said={said} emphasis={AlertEmphasis::Soft}><p>{NOT_SENT}</p></FailedAlert>
    }
}

/// Sends the form around it whenever one of its controls changes: a section saves itself, a
/// report's window or a picked batch is read again, as the React screens did. The form keeps a
/// submit button for a browser without scripts.
#[component(js)]
pub fn SubmitsOnChange(children: impl Render) -> impl Render {
    html! { <div on:change={js::submit(event)}>{children}</div> }
}
