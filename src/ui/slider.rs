// corten ui 0.1.0: slider 7b2483bb57c961bc
//! A value in a range, as the classes of the `<input type="range">` you write:
//! `<input type="range" name={f.volume} min="0" max="100" value="40" class={Slider {}}>`. Give it
//! a label, as any field (`Field`).
use corten::prelude::*;

/// A part without a rule in `slider.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Slider() -> impl ClassList {
///     (Slider, Vertical)
/// }
/// ```
#[component(css)]
pub fn Slider() -> impl ClassList {
    Slider
}
