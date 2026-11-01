// corten ui 0.1.0: slider e4befe6bb6bfa9fd
//! A value in a range, on the `<input type="range">` written inside it:
//! `<Slider><input type="range" name={f.volume} min="0" max="100" value="40"></Slider>`. Give
//! it a label, as any field (`Field`).
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Slider() -> impl Render {
///     html! { <span class={(Slider, Vertical)}></span> }
/// }
/// ```
#[component(css)]
pub fn Slider<C: Render>(children: C) -> impl Render {
    html! { <span class={Slider}>{children}</span> }
}
