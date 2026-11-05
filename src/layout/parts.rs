//! Pieces screens draw the same way: a notice, a form's own message, and a form sent on change. A labeled field is the
//! kit's `ui::field::Field`.
use corten::prelude::*;

use crate::ui::alert::{Alert, AlertEmphasis, AlertVariant, FormAlert};

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

/// Says in the page's toaster (inside it) when a `data-patch` submit got no answer to draw: the
/// network failed, the connection closed during an upload, or a proxy answered for the app. The
/// React app showed its error boundary; the runtime only dispatches `corten:error` on the form,
/// which the kit's `Toaster` does not show (corten#903). Its own component because the layout's
/// script handlers are not in scope in a `-> impl Document` component (corten#906).
#[component(js)]
pub fn SaysFailedSubmits(children: impl Render) -> impl Render {
    html! { <div on:connect={js::connect(signal)}>{children}</div> }
}

/// Sends the form around it whenever one of its controls changes: a section saves itself, a
/// report's window or a picked batch is read again, as the React screens did. The form keeps a
/// submit button for a browser without scripts.
#[component(js)]
pub fn SubmitsOnChange(children: impl Render) -> impl Render {
    html! { <div on:change={js::submit(event)}>{children}</div> }
}
