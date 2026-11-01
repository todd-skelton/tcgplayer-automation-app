// corten ui 0.1.0: field 4a66e9b77c27ab18
//! A label, the control it names and a note under them: a hint in text, or the field's error
//! from the server (`e.message(f.email)`, drawn in the destructive color). `id` is the
//! control's: the label's `for`. (A label around the control would name its first labelable
//! element, which in corten-ui's `NumberField` is a step button.)
//!
//! ```rust,ignore
//! <Field id="email" label="Email" note={e.message(f.email)}>
//!     <Input><input id="email" type="email" name={f.email} {..e.aria(f.email)}></Input>
//! </Field>
//! <Field id="qty" label={t.quantity()} note=""><NumberField field={&qty} /></Field>
//! ```
//!
//! `note=""` when there is none. A hint the control should announce takes an id
//! (`<span id={EmailHint}>..</span>`) named by `e.aria(f.email).hint(&EmailHint)`. A checkbox, a
//! switch and a radio button put their label after the control: `Checkbox`, `Switch` and
//! `Radio` do that.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Field() -> impl Render {
///     html! { <div class={(Field, Inline)}></div> }
/// }
/// ```
#[component(css)]
pub fn Field<'a, C: Render, N: Render>(
    id: &'a str,
    label: &'a str,
    note: N,
    children: C,
) -> impl Render {
    html! {
        <div class={Field}>
            <label for={id}>{label}</label>
            <div class={Control}>{children}</div>
            <div class={Note}>{note}</div>
        </div>
    }
}
