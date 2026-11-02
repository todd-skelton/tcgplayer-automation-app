// corten ui 0.1.0: field b99c536468c44042
//! A label, the control it names, a hint and the field's error from the server
//! (`e.message(f.email)`, drawn in the destructive color). `id` is the control's, a `#[derive(Id)]`
//! type as every element id is: the label's `for` is written from it, and the app writes the same
//! type on the control, so a misspelled name does not compile, though another id type on the control
//! does and leaves the label naming nothing. In a list, the id holds the row's key
//! (`struct PriceId<'a>(&'a str)`).
//! (A label around the control would name its first labelable element, which in corten-ui's
//! `NumberField` is a step button.)
//!
//! The hint is in an element whose id is `FieldHintId(&id)`: give it to the control's
//! description with `e.aria(..).hint(..)`, so a screen reader reads the hint, then the error:
//!
//! ```rust,ignore
//! <Field id={EmailId} label="Email" hint="Where we send the receipt." error={e.message(f.email)}>
//!     <input class={Input {}} id={EmailId} type="email" name={f.email} {..e.aria(f.email).hint(&FieldHintId(&EmailId))}>
//! </Field>
//! <Field id={QtyId} label={t.quantity()} hint="" error=""><NumberField field={&qty} /></Field>
//! ```
//!
//! `hint=""` and `error=""` show nothing (the hint's element is still written, empty), so name the
//! hint in the control's description only when it has text. A checkbox, a switch and a radio button put their label
//! after the control: `Checkbox`, `Switch` and `Radio` do that.
use corten::prelude::*;

/// The id of a field's hint, from its control's: `field-hint-email` for `EmailId`.
#[derive(Id)]
pub struct FieldHintId<'a, I: Id>(pub &'a I);

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
pub fn Field<'a, I: Id, H: Render, E: Render, C: Render>(
    id: I,
    label: &'a str,
    hint: H,
    error: E,
    children: C,
) -> impl Render {
    html! {
        <div class={Field}>
            <label for={&id}>{label}</label>
            <div class={Control}>{children}</div>
            <p class={Hint} id={FieldHintId(&id)}>{hint}</p>
            <div class={Note}>{error}</div>
        </div>
    }
}
