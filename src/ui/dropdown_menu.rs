// corten ui 0.1.0: dropdown_menu 3e3eaf50a37d5430
//! The look of corten-ui's `MenuButton` written inside it: an outline trigger and a menu under
//! it. The items are the app's (`role="menuitem"` links, post forms, dialog commands), so the
//! app lists `corten_ui::COMPONENTS` too. A `<hr role="separator">` between items groups them.
//!
//! ```rust,ignore
//! <DropdownMenu>
//!     <MenuButton id="account" label="Account">
//!         <a role="menuitem" href={url::Orders}>"Orders"</a>
//!         <hr role="separator">
//!         <form method="post" action={url::SignOut}><button role="menuitem">"Sign out"</button></form>
//!     </MenuButton>
//! </DropdownMenu>
//! ```
use corten::prelude::*;

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
pub fn DropdownMenu<C: Render>(children: C) -> impl Render {
    html! { <div class={Menu}>{children}</div> }
}
