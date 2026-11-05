// corten ui 0.1.0: checkbox 85396e75f9b2af1d
//! A checkbox and its label after it, on the `<input type="checkbox">` written inside:
//! `<Checkbox label="Email me about orders"><input type="checkbox" name={f.updates}></Checkbox>`.
//! A checkbox with `role="switch"` belongs in `Switch`; here it is left to the browser's own look.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Checkbox() -> impl Render {
///     html! { <label class={(Checkbox, Round)}></label> }
/// }
/// ```
#[component(css)]
pub fn Checkbox<'a, C: Render>(label: &'a str, children: C) -> impl Render {
    html! { <label class={Checkbox}>{children}<span>{label}</span></label> }
}
