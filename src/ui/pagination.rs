// corten ui 0.1.0: pagination d86a71b5e535f6d2
//! Links to the pages of a list. `link` builds a page's typed route (the list's route with its
//! page), so every link is a plain link that works without JavaScript and cannot point at a page
//! that does not exist. The labels are the app's, in its language:
//!
//! ```rust,ignore
//! <Pagination label="Pages" previous_label="Previous" next_label="Next"
//!     pages={total} current={page} link={&|page| Box::new(url::Orders { page: Some(page) })} />
//! ```
//!
//! Pages count from 1. A long list shows the first and last pages and two on each side of the
//! current one, with a gap between; Previous and Next are disabled at the ends.
use corten::{Href, prelude::*};

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Pagination() -> impl Render {
///     html! { <nav class={(Pagination, Rounded)}></nav> }
/// }
/// ```
#[component(css)]
pub fn Pagination<'a>(
    label: &'a str,
    previous_label: &'a str,
    next_label: &'a str,
    pages: usize,
    current: usize,
    link: &'a dyn Fn(usize) -> Box<dyn Href + 'a>,
) -> impl Render {
    let shown = |n: usize| n == 1 || n == pages || n.abs_diff(current) <= 2;
    html! {
        <nav class={Pagination} aria-label={label}>
            <ul>
                <li>
                    if current > 1 {
                        <a class={(Step, Previous)} href={link(current - 1)} rel="prev">
                            {previous_label}
                        </a>
                    } else {
                        <span class={(Step, Previous)} aria-disabled="true">{previous_label}</span>
                    }
                </li>
                for n in 1..=pages {
                    if shown(n) {
                        <li>
                            if n == current {
                                <a class={Page} href={link(n)} aria-current="page">{n}</a>
                            } else {
                                <a class={Page} href={link(n)}>{n}</a>
                            }
                        </li>
                    } else if shown(n - 1) {
                        <li class={Gap} aria-hidden="true"></li>
                    }
                }
                <li>
                    if current < pages {
                        <a class={(Step, Next)} href={link(current + 1)} rel="next">{next_label}</a>
                    } else {
                        <span class={(Step, Next)} aria-disabled="true">{next_label}</span>
                    }
                </li>
            </ul>
        </nav>
    }
}
