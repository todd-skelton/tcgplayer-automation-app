// corten ui 0.1.0: progress e3504120f64b246b
//! Progress through a task (a job's steps, an upload), as the classes of the `<progress>` you
//! write, named by a label as any control, so a screen reader reads how far along it is:
//!
//! ```rust,ignore
//! <Field id={StepsId} label="Pricing the batch" hint="" error="">
//!     <progress class={Progress { size: ProgressSize::Md, tone: ProgressTone::Primary }}
//!         id={StepsId} max={steps} value={done}>
//!         {done}" of "{steps}
//!     </progress>
//! </Field>
//! ```
//!
//! The text inside is what a browser without the element shows. With no `value`, how far along is
//! not known yet (a job starting): a band moves across the track, or stripes fill it under reduced
//! motion. Under forced colors the bar is drawn in the system's colors. `ProgressSize::Sm` is a
//! thinner bar, for one nested under another (the items of the current step). A measure in a known
//! range that is not progress (quota used) is a `Meter`.
//!
//! A tone is the fill's color: `ProgressTone::Primary` while a task runs, and the color of how it
//! ended once it has (`Success` when every line is packed, `Destructive` when an import failed).
//! Say what the color means in the label or the text beside the bar, since color alone does not
//! tell everyone, and forced colors draws every tone alike.
use corten::prelude::*;

/// A bar's thickness. Each is a class in `progress.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressSize {
    /// The meter's height.
    Md,
    /// Half of it, for a bar nested under another.
    Sm,
}

/// The fill's color, one of the theme's tones: each is a class in `progress.css`, so one without a
/// rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressTone {
    /// The theme's primary color, for a task under way.
    Primary,
    /// The theme's info color, for a task under way on a screen where primary marks its actions.
    Info,
    /// A task that finished.
    Success,
    /// A task that finished with something to look at, or is running late.
    Warning,
    /// A task that failed.
    Destructive,
}

/// A part without a rule in `progress.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Progress() -> impl ClassList {
///     (Progress, Lg)
/// }
/// ```
#[component(css)]
pub fn Progress(size: ProgressSize, tone: ProgressTone) -> impl ClassList {
    let size = match size {
        ProgressSize::Md => None,
        ProgressSize::Sm => Some(Sm),
    };
    let tone = match tone {
        ProgressTone::Primary => None,
        ProgressTone::Info => Some(Info),
        ProgressTone::Success => Some(Success),
        ProgressTone::Warning => Some(Warning),
        ProgressTone::Destructive => Some(Destructive),
    };
    (Progress, size, tone)
}
