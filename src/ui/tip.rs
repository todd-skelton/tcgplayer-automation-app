// corten ui 0.1.0: tip 344f6b46777b361a
//! The look of corten-ui's `Tooltip`: a small box in the page's colors reversed, above the control
//! that showed it (below it when there is no room). Its behavior and markup are corten-ui's
//! (docs/guide/ui.md), so the app lists `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <button class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Icon }} type="button" interestfor={SettingsTipId} aria-labelledby={SettingsTipId}>
//!     <span aria-hidden="true">"⚙"</span>
//! </button>
//! <Tooltip id={SettingsTipId} class={Tip {}}>"Settings"</Tooltip>
//! ```
//!
//! A tooltip is for a name or a hint. Without a script it shows only in Chromium (a screen reader
//! reads it everywhere), so an icon-only control's icon is one whose meaning shows, and what a
//! user must read to act (a field's error, a price's reason) is on the page, or in a `Popover` a
//! click opens, which a phone opens too.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Tip() -> impl ClassList {
///     (Tip, Arrow)
/// }
/// ```
#[component(css)]
pub fn Tip() -> impl ClassList {
    Tip
}
