// corten ui 0.1.0: radio_group 02f684afc0e8559a
//! A group of radio buttons: a `<fieldset>` with its legend, and each choice's label after its
//! `<input type="radio">`:
//!
//! ```rust,ignore
//! <RadioGroup legend="Shipping">
//!     <Radio label="Standard"><input type="radio" name={f.shipping} value="standard" checked></Radio>
//!     <Radio label="Express"><input type="radio" name={f.shipping} value="express"></Radio>
//! </RadioGroup>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn RadioGroup() -> impl Render {
///     html! { <fieldset class={(Group, Horizontal)}></fieldset> }
/// }
/// ```
#[component(css)]
pub fn RadioGroup<'a, C: Render>(legend: &'a str, children: C) -> impl Render {
    html! {
        <fieldset class={Group}>
            <legend>{legend}</legend>
            {children}
        </fieldset>
    }
}

#[component(css = RadioGroup)]
pub fn Radio<'a, C: Render>(label: &'a str, children: C) -> impl Render {
    html! { <label class={Radio}>{children}<span>{label}</span></label> }
}
