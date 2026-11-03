// corten ui 0.1.0: input_group 371a6b545dd78a81
//! A text field with something inside its border: a sign or a unit before or after the text
//! (`$`, `oz`), or a button (a search's, a password's reveal). `InputGroup` is the look of a
//! `<span>` around the control and what goes with it: the span draws the box, its focus ring and
//! its invalid and disabled states, and the `<input>` inside keeps its `Input` look without its
//! own border. In a `Field` the input keeps the field's id, so the label still names it, and the
//! group fills the field's row; `ControlWidth` goes on the group.
//!
//! ```rust,ignore
//! <Field id={e.id(f.floor)} label="Lowest offer (USD)" hint="" error={e.message(f.floor)}>
//!     <span class={(InputGroup {}, ControlWidth { width: Width::Sm })}>
//!         <Adornment>"$"</Adornment>
//!         <input class={Input {}} inputmode="decimal" {..e.control(f.floor)}>
//!     </span>
//! </Field>
//! ```
//!
//! An `Adornment` is hidden from a screen reader, so the label or the hint says what it shows
//! ("(USD)", "in ounces"). A button inside is a `Button` after the input (`Sm`, or `Icon` with
//! hidden text), named as any button is, and kept within the border.
use corten::prelude::*;

/// A part without a rule in `input_group.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn InputGroup() -> impl ClassList {
///     (InputGroup, Large)
/// }
/// ```
#[component(css)]
pub fn InputGroup() -> impl ClassList {
    InputGroup
}

/// A short sign or unit inside the group's border, before or after its input; a screen reader
/// skips it.
#[component(css = InputGroup)]
pub fn Adornment<C: Render>(children: C) -> impl Render {
    html! { <span class={Adornment} aria-hidden="true">{children}</span> }
}
