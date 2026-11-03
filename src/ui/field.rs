// corten ui 0.1.0: field 2983c2f884e25295
//! A label, the control it names, a hint and the field's error from the server
//! (`e.message(f.email)`, drawn in the destructive color). `id` is the control's: for a form
//! field, `e.id(f.email)`, the form's id and the field's name, which the control writes with
//! `{..e.control(f.email)}` (its `id`, `name` and the ARIA `e.aria(..)` writes), so the label
//! and the control are named from one field and need no id type of their own (`e` is
//! `errors.within(FormId)`, or `Within::none(FormId)` for a form with no messages). Another control
//! takes a `#[derive(Id)]` type written on both; in a list, the id holds the row's key
//! (`struct PriceId<'a>(&'a str)`).
//! (A label around the control would name its first labelable element, which in corten-ui's
//! `NumberField` is a step button.)
//!
//! The hint is in an element whose id is `HintId(&id)`: `.hint()` puts it in the control's
//! description, so a screen reader reads the hint, then the error:
//!
//! ```rust,ignore
//! <Field id={e.id(f.email)} label="Email" hint="Where we send the receipt." error={e.message(f.email)}>
//!     <input class={Input {}} type="email" {..e.control(f.email).hint()}>
//! </Field>
//! <Field id={QtyId} label={t.quantity()} hint="" error=""><NumberField field={&qty} /></Field>
//! ```
//!
//! `hint=""` and `error=""` show nothing. The hint's element is still written, empty, so give the
//! control `.hint()` whether or not the hint has text: an empty hint describes nothing. A corten-ui
//! widget names it in its `attrs` (`&[("aria-describedby", HintId(&QtyId))]`). A hint with text
//! that its control does not name is an error in a debug build. A checkbox, a switch and a radio
//! button put their label after the control: `Checkbox`, `Switch` and `Radio` do that.
use corten::{form::HintId, prelude::*};

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
            <p class={Hint} id={HintId(&id)}>{hint}</p>
            <div class={Note}>{error}</div>
        </div>
    }
}
