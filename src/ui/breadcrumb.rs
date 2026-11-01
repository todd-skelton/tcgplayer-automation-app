// corten ui 0.1.0: breadcrumb d78c08f9459309cd
//! Where the page sits: a link to each page above it, then the page itself. Each link is a typed
//! route, so a crumb cannot point at a page that does not exist:
//!
//! ```rust,ignore
//! <Breadcrumb label="Breadcrumb" crumbs={&[Crumb { label: "Home", link: &url::Home }, Crumb { label: "Sets", link: &url::Sets }]} current="Base Set" />
//! ```
use corten::{Href, prelude::*};

/// A page above this one.
pub struct Crumb<'a> {
    pub label: &'a str,
    pub link: &'a dyn Href,
}

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Breadcrumb() -> impl Render {
///     html! { <nav class={(Breadcrumb, Compact)}></nav> }
/// }
/// ```
#[component(css)]
pub fn Breadcrumb<'a>(label: &'a str, crumbs: &'a [Crumb<'a>], current: &'a str) -> impl Render {
    html! {
        <nav class={Breadcrumb} aria-label={label}>
            <ol>
                for crumb in crumbs {
                    <li><a href={crumb.link}>{crumb.label}</a></li>
                }
                <li><span aria-current="page">{current}</span></li>
            </ol>
        </nav>
    }
}
