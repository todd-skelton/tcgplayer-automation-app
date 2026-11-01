// corten ui 0.1.0: select f99d0c2a51cd0044
//! A choice from a list, on the `<select>` written inside it, so it posts and works with the
//! keyboard as the platform's does: `<Select><select name={f.size}><option>"S"</option></select></Select>`.
//! Where the browser supports `appearance: base-select`, the open list is styled too.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Select() -> impl Render {
///     html! { <span class={(Select, Multiple)}></span> }
/// }
/// ```
#[component(css)]
pub fn Select<C: Render>(children: C) -> impl Render {
    html! { <span class={Select}>{children}</span> }
}
