use corten::prelude::*;

use super::{Chrome, PRIMARY, SETTINGS, ScreenLink};
use crate::{
    app,
    features::http_configuration,
    ui::{
        nav_bar::{NavActions, NavBar, NavBrand, NavSections},
        popover::Popover,
    },
};

/// The settings menu, a popover its button opens with no script.
#[derive(Id)]
struct SettingsMenuId;

/// Where the auth cookie warning goes, there or not, so a write that sets the cookie can patch it.
#[derive(Id)]
struct AuthCookieWarningId;

/// The bar across the top, the kit's `NavBar` in the app's bar colors: the app's name, its
/// screens (one row that scrolls sideways on a narrow screen), the auth cookie warning and the
/// settings menu.
#[component(css)]
pub fn AppBar<'a>(req: &'a Req, chrome: Chrome) -> impl Render {
    html! {
        <header class={(NavBar {}, Bar)}>
            <a class={NavBrand {}} href={app::url::Home}>"TCGPlayer Automation"</a>
            <nav class={NavSections {}} aria-label="Screens">
                for e in PRIMARY.iter() {
                    <ScreenLink req={req} screen={&e.screen}>{e.label}</ScreenLink>
                }
            </nav>
            <div class={NavActions {}}>
                <AuthCookieWarning missing={chrome.auth_cookie_missing} />
                <button type="button" class={Settings} popovertarget={SettingsMenuId}>
                    "Settings"
                </button>
            </div>
            <nav id={SettingsMenuId} class={(Popover {}, Menu)} popover aria-label="Settings">
                for e in SETTINGS.iter() {
                    <ScreenLink req={req} screen={&e.screen}>{e.label}</ScreenLink>
                }
            </nav>
        </header>
    }
}

/// The link to the HTTP settings while TCGplayer's auth cookie is not set. A navigation keeps the
/// bar a full load drew, so the write that sets the cookie answers with this.
#[component(css = AppBar)]
pub fn AuthCookieWarning(missing: bool) -> impl Patch {
    html! {
        <span id={AuthCookieWarningId} class={CookieWarning}>
            if missing {
                <a
                    class={Warning}
                    href={http_configuration::url::HttpSettings}
                >
                    "⚠ Auth cookie not configured"
                </a>
            }
        </span>
    }
}
