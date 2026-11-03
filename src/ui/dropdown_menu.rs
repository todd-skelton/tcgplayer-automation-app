// corten ui 0.1.0: dropdown_menu b51b420b35a4c0e3
//! The look of corten-ui's `MenuButton` written inside it: a trigger and a menu under it. The
//! items are the app's (`role="menuitem"` links, post forms, dialog commands), so the app lists
//! `corten_ui::COMPONENTS` too. A `<hr role="separator">` between items groups them.
//!
//! ```rust,ignore
//! <DropdownMenu trigger={MenuTrigger::Text}>
//!     <MenuButton id={AccountMenuId} label="Account">
//!         <a role="menuitem" href={url::Orders}>"Orders"</a>
//!         <hr role="separator">
//!         <form method="post" action={url::SignOut}><button role="menuitem">"Sign out"</button></form>
//!     </MenuButton>
//! </DropdownMenu>
//! ```
//!
//! `MenuTrigger::Icon` is a row's "more actions" menu: the trigger holds an icon a screen reader
//! skips (the kit's `Icon`, `corten ui add icon`, which is `aria-hidden`) and its name in
//! `VisuallyHidden` text.
use corten::prelude::*;

/// What the trigger holds. `Icon` is a class in `dropdown_menu.css`, so it does not compile
/// without its rule; `Text` is the trigger as it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuTrigger {
    /// Its name, in an outline button with a chevron after it.
    Text,
    /// An icon, in a square ghost button at the control's height with no chevron; its name is
    /// visually hidden text.
    Icon,
}

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn DropdownMenu() -> impl Render {
///     html! { <div class={(Menu, Wide)}></div> }
/// }
/// ```
#[component(css)]
pub fn DropdownMenu<C: Render>(trigger: MenuTrigger, children: C) -> impl Render {
    html! {
        match trigger {
            MenuTrigger::Text => <div class={Menu}>{children}</div>,
            MenuTrigger::Icon => <div class={(Menu, Icon)}>{children}</div>,
        }
    }
}
