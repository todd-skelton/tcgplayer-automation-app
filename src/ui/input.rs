// corten ui 0.1.0: input a5832f0913bee9db
//! A text field's look, as the classes of the `<input>` you write. The element is yours, so its
//! `name={f.email}`, `type`, `required` and the rest are checked as always, and the page has no
//! element of the kit's around it:
//!
//! ```rust,ignore
//! <input type="email" name={f.email} required class={Input {}}>
//! ```
//!
//! A field the browser finds invalid after the user edits it (`:user-invalid`), or one the
//! server marked (`aria-invalid="true"`, which `e.aria(field)` writes), gets the destructive
//! border.
use corten::prelude::*;

/// A part without a rule in `input.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Input() -> impl ClassList {
///     (Input, Large)
/// }
/// ```
#[component(css)]
pub fn Input() -> impl ClassList {
    Input
}
