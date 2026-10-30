//! The document around every page: the app bar with the screens, the settings menu and the
//! warning when TCGplayer's auth cookie is not set, as the React app's `root.tsx` draws them.
use corten::prelude::*;

use crate::{
    database::Database,
    features::{
        batch_pricer, configuration, http_configuration, inventory_economics, inventory_intake,
        product_price_matrix, publication_configuration, pull_sheet, shipping_configuration,
        shipping_export, slab_connections,
    },
    legacy::screens,
    theme::*,
};

mod app_bar;
mod icons;
mod parts;

pub use app_bar::AppBar;
pub use icons::{Glyph, Icon};
pub use parts::{Field, Notice, SubmitsOnChange, Tone};

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

/// A page: the app bar and the screen. `head` is what the page adds to its head (`""` for
/// nothing), such as a `ReadAgain` while it waits on a job.
#[component]
pub fn Layout<'a>(
    req: &'a Req,
    title: &'a str,
    chrome: Chrome,
    head: impl Render,
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
                {head}
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
    InventoryManager,
    BatchPricer,
    PullSheet,
    ShippingWorkflow,
    ProductPriceMatrix,
    InventoryEconomics,
    HttpConfiguration,
    ShippingConfiguration,
    SlabConnections,
    PublicationConfiguration,
    Configuration,
    Legacy(screens::Screen),
}

/// A screen as the menus and the dashboard list it, as `appNavigation`'s items.
pub struct Entry {
    pub screen: Screen,
    pub label: &'static str,
    pub description: &'static str,
    pub icon: Icon,
}

const fn entry(
    screen: Screen,
    label: &'static str,
    description: &'static str,
    icon: Icon,
) -> Entry {
    Entry {
        screen,
        label,
        description,
        icon,
    }
}

/// The screens in the order the React app's `primaryNavigationItems` lists them.
pub const PRIMARY: [Entry; 10] = [
    entry(
        Screen::InventoryManager,
        "Inventory",
        "Add new inventory and freeze it into a pricing batch",
        icons::INVENTORY,
    ),
    entry(
        Screen::BatchPricer,
        "Batch Pricer",
        "Create, price, publish, and download inventory batches",
        icons::BATCH_PREDICTION,
    ),
    entry(
        Screen::Legacy(screens::Screen::ContinuousPricing),
        "Continuous Pricing",
        "Automatic repricing runs for live inventory",
        icons::LOOP,
    ),
    entry(
        Screen::Legacy(screens::Screen::SlabPricing),
        "Slab Pricing",
        "Research and price graded cards for eBay",
        icons::PRICE_CHECK,
    ),
    entry(
        Screen::ProductPriceMatrix,
        "Price Matrix",
        "Compare one product across conditions and variants",
        icons::PRICE_CHECK,
    ),
    entry(
        Screen::Legacy(screens::Screen::InventoryStrategy),
        "Inventory Strategy",
        "Pricing hurdle, capital turnaround, and selling speed",
        icons::QUERY_STATS,
    ),
    entry(
        Screen::InventoryEconomics,
        "Inventory Economics",
        "Estimated cost, proceeds, and realized profit by order",
        icons::WALLET,
    ),
    entry(
        Screen::PullSheet,
        "Pull Sheet",
        "Upload and view pull sheets",
        icons::VIEW_LIST,
    ),
    entry(
        Screen::ShippingWorkflow,
        "Shipping Export",
        "Review shipments, buy postage, and notify buyers",
        icons::LOCAL_SHIPPING,
    ),
    entry(
        Screen::Legacy(screens::Screen::DataManagement),
        "Data Mgmt",
        "Refresh product lines, sets, products, and SKUs",
        icons::STORAGE,
    ),
];

/// The settings menu, as `settingsNavigationItems` lists it.
pub const SETTINGS: [Entry; 5] = [
    entry(
        Screen::Configuration,
        "Configuration",
        "Pricing rules and defaults",
        icons::SETTINGS,
    ),
    entry(
        Screen::PublicationConfiguration,
        "Inventory Publication",
        "Automatic publication and guardrails",
        icons::PUBLISH,
    ),
    entry(
        Screen::ShippingConfiguration,
        "Shipping Configuration",
        "Postage and shipping defaults",
        icons::LOCAL_SHIPPING,
    ),
    entry(
        Screen::HttpConfiguration,
        "HTTP Configuration",
        "TCGPlayer authentication and rate limits",
        icons::HTTP,
    ),
    entry(
        Screen::SlabConnections,
        "Slab data connections",
        "eBay research and Alt credentials",
        icons::HTTP,
    ),
];

/// A link to a screen, marked when it is the page shown. A screen the React app serves loads in
/// full (`data-reload`): the runtime cannot swap in a page another app rendered.
#[component]
pub fn ScreenLink<'a>(req: &'a Req, screen: &'a Screen, children: impl Render) -> impl Render {
    html! {
        match screen {
            Screen::InventoryManager => {
                <a
                    {..req.nav(&inventory_intake::url::InventoryManager { selection: Default::default(), queued: None })}
                >
                    {children}
                </a>
            }
            Screen::PullSheet => <a {..req.nav(&pull_sheet::url::PullSheets)}>{children}</a>,
            Screen::InventoryEconomics => {
                <a {..req.nav(&inventory_economics::url::InventoryEconomics)}>{children}</a>
            }
            Screen::ProductPriceMatrix => {
                <a
                    {..req.nav(&product_price_matrix::url::ProductPriceMatrix { choice: Default::default() })}
                >
                    {children}
                </a>
            }
            Screen::ShippingWorkflow => {
                <a
                    {..req.nav(&shipping_export::url::ShippingWorkflow { step: None, seller: None, edit: None, shipment: None, view: None, filters: Default::default() })}
                >
                    {children}
                </a>
            }
            Screen::BatchPricer => {
                <a {..req.nav(&batch_pricer::url::BatchPricer::newest())}>{children}</a>
            }
            Screen::HttpConfiguration => {
                <a {..req.nav(&http_configuration::url::HttpSettings { done: None })}>{children}</a>
            }
            Screen::ShippingConfiguration => {
                <a {..req.nav(&shipping_configuration::url::ShippingSettings { done: None })}>
                    {children}
                </a>
            }
            Screen::SlabConnections => {
                <a {..req.nav(&slab_connections::url::SlabConnections)}>{children}</a>
            }
            Screen::PublicationConfiguration => {
                <a {..req.nav(&publication_configuration::url::PublicationSettings { done: None })}>
                    {children}
                </a>
            }
            Screen::Configuration => {
                <a {..req.nav(&configuration::url::Configuration { done: None })}>{children}</a>
            }
            Screen::Legacy(legacy) => <a href={*legacy} data-reload>{children}</a>,
        }
    }
}
