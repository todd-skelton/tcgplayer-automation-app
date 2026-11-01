// corten ui 0.1.0: tabs 92974ce490e3bfa3
//! The look of corten-ui's `TabGroup` written inside it: the tab list as a segmented control,
//! the selected tab raised. Its behavior and markup are corten-ui's (docs/guide/ui.md); this
//! styles them by role and state, so the app lists `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <Tabs><TabGroup id="book" label={t.market()} tabs={&tabs} selected={0} /></Tabs>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Tabs() -> impl Render {
///     html! { <div class={(Tabs, Vertical)}></div> }
/// }
/// ```
#[component(css)]
pub fn Tabs<C: Render>(children: C) -> impl Render {
    html! { <div class={Tabs}>{children}</div> }
}
