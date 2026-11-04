// corten ui 0.1.0: tip ab75abcf51783e2e
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
//!
//! Text that shows a tooltip (a name whose address shows on hover, "3 orders" with their numbers)
//! is a button too, since only `<a>`, `<button>` and `<area>` can show one (`interestfor`'s rule,
//! which the script follows), drawn by `TipText` as the text around it:
//!
//! ```rust,ignore
//! <p>"Held for "<button class={TipText {}} type="button" interestfor={HeldTipId} aria-describedby={HeldTipId}>"3 orders"</button></p>
//! <Tooltip id={HeldTipId} class={Tip {}}>"#1041, #1043 and #1050"</Tooltip>
//! ```
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

/// On a `<button type="button">` that shows a tooltip: drawn as the text around it (its font,
/// color and alignment, no border, background or padding) with a dotted underline that says more
/// is there, and the kit's focus ring. It wins over a bare `button {}` rule of the app's, and the
/// app's class on the same button (one that sets the text's size) wins over it whichever comes
/// first. A rule with more than the element (`button:hover`, `[type=button]`, a reset's
/// `button, [type='button']`) still reaches it, so keep a button's look on a class (the kit's
/// `Button`), not on the element.
///
/// A button is one box, so the text does not wrap with the words around it: keep it to a word or
/// a short phrase (a name, "3 orders"). Pressing it does nothing, though a screen reader still
/// calls it a button, and each one is a stop for Tab, which is how a keyboard shows its tooltip.
#[component(css = Tip)]
pub fn TipText() -> impl ClassList {
    Text
}
