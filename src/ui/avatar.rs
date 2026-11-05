// corten ui 0.1.0: avatar 9056c096006e2240
//! A person's picture over their initials, so the initials show while it loads and when there
//! is none: `<Avatar src={Some(&user.photo)} alt={&user.name} initials="AL" />`.
//! `alt` names the person, on the picture or, with none, on the avatar itself (`role="img"`);
//! `alt=""` when their name is written next to it.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Avatar() -> impl Render {
///     html! { <span class={(Avatar, Square)}></span> }
/// }
/// ```
#[component(css)]
pub fn Avatar<'a>(src: Option<&'a str>, alt: &'a str, initials: &'a str) -> impl Render {
    // With no picture, the box is the image, named as the picture would be; the initials only show.
    let named = src.is_none() && !alt.is_empty();
    html! {
        <span class={Avatar} role={named.then_some("img")} aria-label={named.then_some(alt)}>
            <span class={Initials} aria-hidden="true">{initials}</span>
            if let Some(src) = src {
                <img src={src} alt={alt} loading="lazy" decoding="async">
            }
        </span>
    }
}
