// corten ui 0.1.0: segmented 0e55aa40ea85aa11
//! A segmented control: a few choices side by side, the chosen one raised, as the tab list in
//! `Tabs` is drawn. Two kinds of choice wear it:
//!
//! 1. corten-ui's `ChoiceGroup` written inside `Segmented`: one choice of a few that a script
//!    shows or a link loads (`role="radiogroup"`, the chosen one `aria-checked="true"`). Its
//!    behavior and markup are corten-ui's (docs/guide/ui.md), so the app lists
//!    `corten_ui::COMPONENTS` too.
//! 2. `SegmentedLinks` on a `<nav>` of links, each a view the server renders (a filter, an
//!    order), the current one `aria-current="page"`, which a screen reader announces. They are
//!    navigation, not a choice within the page, and work without a script.
//!
//! ```rust,ignore
//! <Segmented><ChoiceGroup choice={&period} label={t.period()} options={&periods} /></Segmented>
//!
//! <nav class={SegmentedLinks {}} aria-label={t.filter()}>
//!     <a href={url::Accounts { filter: None }} aria-current={current(None)}>{t.all()}</a>
//!     <a href={url::Accounts { filter: Some(Filter::Credits) }} aria-current={current(Some(Filter::Credits))}>{t.credits()}</a>
//! </nav>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Segmented() -> impl Render {
///     html! { <div class={(Segmented, Vertical)}></div> }
/// }
/// ```
#[component(css)]
pub fn Segmented<C: Render>(children: C) -> impl Render {
    html! { <div class={Segmented}>{children}</div> }
}

/// The segmented look on a `<nav>` of links, the current one `aria-current="page"`.
#[component(css = Segmented)]
pub fn SegmentedLinks() -> impl ClassList {
    Links
}
