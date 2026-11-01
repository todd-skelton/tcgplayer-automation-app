//! Pieces screens draw the same way: a labeled field and a form sent on change.
use corten::prelude::*;

/// A control with its label above and its hint below; `hint` may be empty. The control, and its
/// error message after it, are the children. The design system's field is `ui::field::Field`,
/// whose label names its control by id; a form moves to it as its page moves to `crate::ui`.
#[component(css)]
pub fn LabeledControl<'a>(label: &'a str, hint: &'a str, children: impl Render) -> impl Render {
    html! {
        <label class={LabeledControl}>
            <span>{label}</span>
            {children}
            if !hint.is_empty() {
                <small>{hint}</small>
            }
        </label>
    }
}

/// Sends the form around it whenever one of its controls changes: a section saves itself, a
/// report's window or a picked batch is read again, as the React screens did. The form keeps a
/// submit button for a browser without scripts.
#[component(js)]
pub fn SubmitsOnChange(children: impl Render) -> impl Render {
    html! { <div on:change={js::submit(event)}>{children}</div> }
}
