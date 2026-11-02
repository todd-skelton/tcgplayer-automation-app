//! Progress through a task: a `<progress>` in the theme's track and fill, in place of the browser's
//! own colors, which follow neither the theme nor its dark scheme. The app's own until the kit has
//! one (corten#632); its rules are the kit meter's.
//!
//! ```rust,ignore
//! <ProgressBar size={ProgressSize::Md} done={Some(40.0)} label="Batch pricing progress" />
//! ```
//!
//! With no `done` it is indeterminate: a band sweeps the track, and holds still for a reader who
//! asks for reduced motion.
use corten::prelude::*;

/// The bar's thickness. Each is a class in `progress_bar.css`, so one without a rule does not
/// compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressSize {
    Md,
    /// A bar nested under another, such as the items in the current step.
    Sm,
}

/// `done` is a percentage, 0 to 100; `None` while how far it got is not known yet.
#[component(css)]
pub fn ProgressBar<'a>(size: ProgressSize, done: Option<f64>, label: &'a str) -> impl Render {
    let size = match size {
        ProgressSize::Md => Md,
        ProgressSize::Sm => Sm,
    };
    html! {
        if let Some(done) = done {
            <progress class={(ProgressBar, size)} max="100" value={done} aria-label={label}></progress>
        } else {
            <progress class={(ProgressBar, size)} aria-label={label}></progress>
        }
    }
}
