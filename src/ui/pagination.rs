// corten ui 0.1.0: pagination 3f2261e9cdfaba08
//! Links to the pages of a list. `link` builds a page's typed route (the list's route with its
//! page), so every link is a plain link that works without JavaScript and cannot point at a page
//! that does not exist. The labels are the app's, in its language:
//!
//! ```rust,ignore
//! <Pagination label="Pages" previous_label="Previous" next_label="Next"
//!     pages={total} current={page} link={|page| url::Orders { page: Some(page) }} />
//! ```
//!
//! `link` is any closure that gives a link (`Href`): a typed route, a `Local` or a `Box<dyn Href>`.
//! Write it inline, or name it before the markup and pass it by value (`link={page_link}`), as the
//! view a component returns keeps it; it may borrow the page's data. A closure that gives
//! `Box::new(route)` gives a box of the route, which is not a link: give the route itself.
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
pub fn Pagination<'a, F: Fn(usize) -> L, L: Href>(
    label: &'a str,
    previous_label: &'a str,
    next_label: &'a str,
    pages: usize,
    current: usize,
    link: F,
) -> impl Render {
    let shown = |n: usize| n == 1 || n == pages || n.abs_diff(current) <= 2;
    html! {
        <nav class={Pagination} aria-label={label}>
            <ul>
                <li>
                    if current > 1 {
                        <a
                            class={(Step, Previous)}
                            href={&link(current - 1) as &dyn Href}
                            rel="prev"
                        >
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
                                <a class={Page} href={&link(n) as &dyn Href} aria-current="page">
                                    {n}
                                </a>
                            } else {
                                <a class={Page} href={&link(n) as &dyn Href}>{n}</a>
                            }
                        </li>
                    } else if shown(n - 1) {
                        <li class={Gap} aria-hidden="true"></li>
                    }
                }
                <li>
                    if current < pages {
                        <a class={(Step, Next)} href={&link(current + 1) as &dyn Href} rel="next">
                            {next_label}
                        </a>
                    } else {
                        <span class={(Step, Next)} aria-disabled="true">{next_label}</span>
                    }
                </li>
            </ul>
        </nav>
    }
}
