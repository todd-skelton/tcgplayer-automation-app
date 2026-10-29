use corten::prelude::*;

use super::{Chrome, PRIMARY, SETTINGS, ScreenLink};
use crate::{features::http_configuration, legacy::screens};

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
            <a class={Name} href={screens::Dashboard} data-reload>"TCGPlayer Automation"</a>
            <nav class={Links} aria-label="Screens">
                for (screen, label) in PRIMARY.iter() {
                    <ScreenLink req={req} screen={screen} label={label} />
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
                for (screen, label) in SETTINGS.iter() {
                    <ScreenLink req={req} screen={screen} label={label} />
                }
            </nav>
            <nav id={ScreensMenuId} class={Menu} popover aria-label="All screens">
                for (screen, label) in PRIMARY.iter().chain(SETTINGS.iter()) {
                    <ScreenLink req={req} screen={screen} label={label} />
                }
            </nav>
        </header>
    }
}
