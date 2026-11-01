// corten ui 0.1.0: alert 428d34de5f2eeeee
//! A message the page calls out. Its heading and text are yours (`<h2>` to `<h6>` or `<strong>`,
//! then `<p>`). A destructive or warning one is `role="alert"`, so a screen reader reads it when a
//! patch brings it in, as a form's error does; a success is `role="status"`, read when the reader
//! is free; a neutral or info one is part of the page, read in its place.
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
    Destructive,
    /// Something done.
    Success,
    /// Something to look at before going on.
    Warning,
    /// Something to know.
    Info,
}

/// A variant without a rule in `alert.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Alert() -> impl Render {
///     html! { <div class={(Alert, Shiny)}></div> }
/// }
/// ```
#[component(css)]
pub fn Alert<C: Render>(variant: AlertVariant, children: C) -> impl Render {
    html! {
        match variant {
            AlertVariant::Neutral => <div class={(Alert, Neutral)}>{children}</div>,
            AlertVariant::Info => <div class={(Alert, Info)}>{children}</div>,
            AlertVariant::Success => <div class={(Alert, Success)} role="status">{children}</div>,
            AlertVariant::Warning => <div class={(Alert, Warning)} role="alert">{children}</div>,
            AlertVariant::Destructive => <div class={(Alert, Destructive)} role="alert">{children}</div>,
        }
    }
}
