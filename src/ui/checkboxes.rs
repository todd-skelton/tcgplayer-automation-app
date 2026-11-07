// corten ui 0.1.0: checkboxes bbefdbb214e3485a
//! The look of corten-ui's `CheckboxGroup` written inside it: its `<fieldset>` and legend
//! drawn as `RadioGroup`'s are, the kit's `Checkbox`es in a column. The group's check (at least
//! one) is corten-ui's, so the app lists `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <Checkboxes>
//!     <CheckboxGroup legend={t.ships_to()} missing={t.choose_a_region()}>
//!         <Checkbox label={t.us()}><input type="checkbox" name={f.ships} value="us"></Checkbox>
//!     </CheckboxGroup>
//! </Checkboxes>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Checkboxes() -> impl Render {
///     html! { <div class={(Checkboxes, Inline)}></div> }
/// }
/// ```
#[component(css)]
pub fn Checkboxes<C: Render>(children: C) -> impl Render {
    html! { <div class={Checkboxes}>{children}</div> }
}
