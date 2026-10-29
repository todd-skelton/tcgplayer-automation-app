//! The document around every page: the app bar with the screens, the settings menu and the
//! warning when TCGplayer's auth cookie is not set, as the React app's `root.tsx` draws them.
use corten::prelude::*;

use crate::{
    database::Database,
    features::{http_configuration, pull_sheet},
    legacy::screens,
    theme::*,
};

mod app_bar;

pub use app_bar::AppBar;

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

/// What the app bar shows that comes from the database: whether TCGplayer's auth cookie is set.
/// Read by each page's handler, since the layout cannot read it itself (corten#209).
#[derive(Clone, Copy)]
pub struct Chrome {
    pub auth_cookie_missing: bool,
}

impl Chrome {
    pub async fn read(db: &Database) -> Self {
        let set: Option<bool> = sqlx::query_scalar(
            "SELECT tcg_auth_cookie IS NOT NULL AND tcg_auth_cookie <> '' FROM http_config LIMIT 1",
        )
        .fetch_optional(&db.0)
        .await
        .ok()
        .flatten();
        Chrome {
            auth_cookie_missing: !set.unwrap_or(false),
        }
    }
}

#[component]
pub fn Layout<'a>(
    req: &'a Req,
    title: &'a str,
    chrome: Chrome,
    children: impl Render,
) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="icon" href={req.asset(Static::FAVICON_ICO)}>
                <title>{title}" | TCGPlayer Automation"</title>
                <Corten />
            </head>
            <body>
                <AppBar req={req} chrome={chrome} />
                <main class={(max_w_page(), mx_auto(), p_5())}>{children}</main>
            </body>
        </html>
    }
}

/// A screen in the app bar: where it is, and whether this app serves it or the React app does.
pub enum Screen {
    PullSheet,
    HttpConfiguration,
    Legacy(screens::Screen),
}

/// The screens in the order the React app's `primaryNavigationItems` lists them.
pub const PRIMARY: [(Screen, &str); 10] = [
    (
        Screen::Legacy(screens::Screen::InventoryManager),
        "Inventory",
    ),
    (
        Screen::Legacy(screens::Screen::PendingInventoryPricer),
        "Batch Pricer",
    ),
    (
        Screen::Legacy(screens::Screen::ContinuousPricing),
        "Continuous Pricing",
    ),
    (Screen::Legacy(screens::Screen::SlabPricing), "Slab Pricing"),
    (
        Screen::Legacy(screens::Screen::ProductPriceMatrix),
        "Price Matrix",
    ),
    (
        Screen::Legacy(screens::Screen::InventoryStrategy),
        "Inventory Strategy",
    ),
    (
        Screen::Legacy(screens::Screen::InventoryEconomics),
        "Inventory Economics",
    ),
    (Screen::PullSheet, "Pull Sheet"),
    (
        Screen::Legacy(screens::Screen::ShippingExport),
        "Shipping Export",
    ),
    (Screen::Legacy(screens::Screen::DataManagement), "Data Mgmt"),
];

/// The settings menu, as `settingsNavigationItems` lists it.
pub const SETTINGS: [(Screen, &str); 5] = [
    (
        Screen::Legacy(screens::Screen::Configuration),
        "Configuration",
    ),
    (
        Screen::Legacy(screens::Screen::PublicationConfiguration),
        "Inventory Publication",
    ),
    (
        Screen::Legacy(screens::Screen::ShippingConfiguration),
        "Shipping Configuration",
    ),
    (Screen::HttpConfiguration, "HTTP Configuration"),
    (
        Screen::Legacy(screens::Screen::SlabConnections),
        "Slab data connections",
    ),
];

/// A link to a screen, marked when it is the page shown. A screen the React app serves loads in
/// full (`data-reload`): the runtime cannot swap in a page another app rendered.
#[component]
pub fn ScreenLink<'a>(req: &'a Req, screen: &'a Screen, label: &'a str) -> impl Render {
    html! {
        match screen {
            Screen::PullSheet => <a {..req.nav(&pull_sheet::url::PullSheets)}>{label}</a>,
            Screen::HttpConfiguration => {
                <a {..req.nav(&http_configuration::url::HttpSettings { done: None })}>{label}</a>
            }
            Screen::Legacy(legacy) => <a href={*legacy} data-reload>{label}</a>,
        }
    }
}
