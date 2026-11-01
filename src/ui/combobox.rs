// corten ui 0.1.0: combobox 4342f021669335e0
//! The look of corten-ui's `ComboBox` written inside it: an input like `Input` and a list under
//! it, the option Enter would pick highlighted and the chosen one checked. Before its script runs
//! (or without one) it is the native `<select>`, styled like `Select`. The app lists
//! `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <Field label={t.color()} note=""><Combobox><ComboBox field={&picker} /></Combobox></Field>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Combobox() -> impl Render {
///     html! { <div class={(Combobox, Large)}></div> }
/// }
/// ```
#[component(css)]
pub fn Combobox<C: Render>(children: C) -> impl Render {
    html! { <div class={Combobox}>{children}</div> }
}
