// corten ui 0.1.0: switch a93bebf009dc3c25
//! An on and off setting: the platform's checkbox with `role="switch"`, so it posts as a checkbox
//! does and a screen reader says on and off. Its label goes after it:
//! `<Switch label="Dark mode"><input type="checkbox" role="switch" name={f.dark}></Switch>`.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Switch() -> impl Render {
///     html! { <label class={(Switch, Large)}></label> }
/// }
/// ```
#[component(css)]
pub fn Switch<'a, C: Render>(label: &'a str, children: C) -> impl Render {
    html! { <label class={Switch}>{children}<span>{label}</span></label> }
}
