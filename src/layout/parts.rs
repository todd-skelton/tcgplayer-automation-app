//! Pieces screens draw the same way: a labeled field, a notice, and a form sent on change.
use corten::prelude::*;

/// A control with its label above and its hint below; `hint` may be empty. The control, and its
/// error message after it, are the children.
#[component(css)]
pub fn Field<'a>(label: &'a str, hint: &'a str, children: impl Render) -> impl Render {
    html! {
        <label class={Field}>
            <span>{label}</span>
            {children}
            if !hint.is_empty() {
                <small>{hint}</small>
            }
        </label>
    }
}

/// How a [`Notice`] reads: done, for your information, or a problem to act on.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Done,
    Info,
    Warning,
}

/// A box of text that stands out from the form around it. A `Done` notice is announced.
#[component(css = Field)]
pub fn Notice(tone: Tone, children: impl Render) -> impl Render {
    html! {
        match tone {
            Tone::Done => <div class={(Notice, Done)} role="status">{children}</div>,
            Tone::Info => <div class={(Notice, Info)}>{children}</div>,
            Tone::Warning => <div class={(Notice, Warning)}>{children}</div>,
        }
    }
}

/// Sends the form around it whenever one of its controls changes: a section saves itself, a
/// report's window or a picked batch is read again, as the React screens did. The form keeps a
/// submit button for a browser without scripts.
#[component(js)]
pub fn SubmitsOnChange(children: impl Render) -> impl Render {
    html! { <div on:change={js::submit(event)}>{children}</div> }
}
