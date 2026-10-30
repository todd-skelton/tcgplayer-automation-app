use corten::prelude::*;

use super::{Chrome, PRIMARY, SETTINGS, ScreenLink};
use crate::{app, features::http_configuration};

/// The settings menu, a popover its button opens with no script.
#[derive(Id)]
struct SettingsMenuId;

/// Every screen, for a screen too narrow for the bar's links.
#[derive(Id)]
struct ScreensMenuId;

/// The bar across the top: the app's name, its screens (in a menu below the widest
/// breakpoint), the auth cookie warning and the settings menu.
#[component(css)]
pub fn AppBar<'a>(req: &'a Req, chrome: Chrome) -> impl Render {
    html! {
        <header class={Bar}>
            <button
                type="button"
                class={MenuButton}
                popovertarget={ScreensMenuId}
                aria-label="Screens"
            >
                "☰"
            </button>
            <a class={Name} href={app::url::Home}>"TCGPlayer Automation"</a>
            <nav class={Links} aria-label="Screens">
                for e in PRIMARY.iter() {
                    <ScreenLink req={req} screen={&e.screen}>{e.label}</ScreenLink>
                }
            </nav>
            <div class={End}>
                if chrome.auth_cookie_missing {
                    <a
                        class={Warning}
                        href={http_configuration::url::HttpSettings { done: None }}
                        title="Auth cookie not configured"
                    >
                        "⚠ Auth cookie not configured"
                    </a>
                }
                <button type="button" class={Settings} popovertarget={SettingsMenuId}>
                    "Settings"
                </button>
            </div>
            <nav id={SettingsMenuId} class={Menu} popover aria-label="Settings">
                for e in SETTINGS.iter() {
                    <ScreenLink req={req} screen={&e.screen}>{e.label}</ScreenLink>
                }
            </nav>
            <nav id={ScreensMenuId} class={Menu} popover aria-label="All screens">
                for e in PRIMARY.iter().chain(SETTINGS.iter()) {
                    <ScreenLink req={req} screen={&e.screen}>{e.label}</ScreenLink>
                }
            </nav>
        </header>
    }
}
