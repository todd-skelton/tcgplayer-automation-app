// corten ui 0.1.0: select 7969098fb4195dec
//! A choice from a list, as the classes of the `<select>` you write, so it posts and works with
//! the keyboard as the platform's does:
//! `<select name={f.size} class={Select {}}><option>"S"</option></select>`. Where the browser
//! supports `appearance: base-select`, the open list is styled too.
use corten::prelude::*;

/// A part without a rule in `select.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Select() -> impl ClassList {
///     (Select, Multiple)
/// }
/// ```
#[component(css)]
pub fn Select() -> impl ClassList {
    Select
}
