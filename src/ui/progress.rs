// corten ui 0.1.0: progress 582a5369d3f6f1bd
//! Progress through a task (a job's steps, an upload), as the classes of the `<progress>` you
//! write, named by a label as any control, so a screen reader reads how far along it is:
//!
//! ```rust,ignore
//! <Field id={StepsId} label="Pricing the batch" hint="" error="">
//!     <progress class={Progress { size: ProgressSize::Md }} id={StepsId} max={steps} value={done}>
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
use corten::prelude::*;

/// A bar's thickness. Each is a class in `progress.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressSize {
    /// The meter's height.
    Md,
    /// Half of it, for a bar nested under another.
    Sm,
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
pub fn Progress(size: ProgressSize) -> impl ClassList {
    let size = match size {
        ProgressSize::Md => None,
        ProgressSize::Sm => Some(Sm),
    };
    (Progress, size)
}
