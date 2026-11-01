// corten ui 0.1.0: textarea f34d1be5067cb456
//! A multi-line field's look, on the `<textarea>` written inside it, as `Input` is for an
//! `<input>`: `<Textarea><textarea name={f.note} rows="4"></textarea></Textarea>`.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Textarea() -> impl Render {
///     html! { <span class={(Textarea, Tall)}></span> }
/// }
/// ```
#[component(css)]
pub fn Textarea<C: Render>(children: C) -> impl Render {
    html! { <span class={Textarea}>{children}</span> }
}
