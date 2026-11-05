//! The document around every page: the app bar with the screens, the settings menu and the
//! warning when TCGplayer's auth cookie is not set, as the React app's `root.tsx` draws them.
use std::future::Future;

use corten::{LayoutRead, http::request::Parts, prelude::*};
use corten_ui::{Toast, Toaster};

use crate::{
    database::Database,
    features::{
        batch_pricer, configuration, continuous_pricing, data_management, http_configuration,
        inventory_economics, inventory_intake, inventory_strategy, product_price_matrix,
        publication_configuration, pull_sheet, shipping_configuration, shipping_export,
        slab_connections, slab_pricing,
    },
    glyphs,
    theme::*,
    ui::icon::{self, Glyph},
};

mod app_bar;
mod error_page;
mod parts;

pub use app_bar::{AppBar, AuthCookieWarning};
pub use error_page::error_page;
pub use parts::{FormNotice, Notice, SubmitsOnChange};

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

/// The app bar's warning that TCGplayer's auth cookie is not set: a layout read, which Corten
/// starts beside the handler of a full load, so no handler reads or passes it. A navigation or a
/// `data-patch` action keeps the bar the full load drew, and a write that changes the cookie
/// patches the warning itself (`AuthCookieWarning`). A page that reads it for its own content
/// gives it (`.give::<AuthCookieMissing>(missing)`).
pub struct AuthCookieMissing(pub Database);

impl LayoutRead for AuthCookieMissing {
    type Value = bool;

    fn start(&self, _: &Parts) -> Option<impl Future<Output = bool> + Send + 'static> {
        let db = self.0.clone();
        Some(async move { auth_cookie_missing(&db).await })
    }

    fn view(missing: &bool) -> impl Render + '_ {
        html! { <AuthCookieWarning missing={*missing} /> }
    }
}

/// Whether TCGplayer's auth cookie is not set; set, when the database does not answer.
pub async fn auth_cookie_missing(db: &Database) -> bool {
    let set: Option<bool> = sqlx::query_scalar(
        "SELECT tcg_auth_cookie IS NOT NULL AND tcg_auth_cookie <> '' FROM http_config LIMIT 1",
    )
    .fetch_optional(&db.0)
    .await
    .ok()
    .flatten();
    !set.unwrap_or(false)
}

/// A page: the app bar, the screen, and the toaster that says what an action did: the notice a
/// write's redirect left (`req.redirect_with_notice`), or a patch's `Toast`. `head` is what the
/// page adds to its head (`""` for nothing), such as a `ReadAgain` while it waits on a job. The
/// toaster also says when a `data-patch` submit got no answer to draw (`failed`), in red.
#[component(css)]
pub fn Layout<'a>(
    req: &'a Req,
    title: &'a str,
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
                <AppBar req={req} />
                <main class={(max_w_page(), mx_auto(), p_5())}>{children}</main>
                <div class={Toasts}>
                    <Toaster
                        close="Dismiss"
                        seconds={10}
                        toast={Toast { message: req.notice() }}
                        failed={html! { <span data-tone="failed">{NOT_SENT}</span> }}
                    />
                </div>
            </body>
        </html>
    }
}

/// What the toaster says when a `data-patch` submit got no answer: the write may or may not have
/// reached the server, and the form keeps what was typed.
const NOT_SENT: &str = "That did not go through, and may not have been saved. Check and try again.";

/// A screen in the app bar.
pub enum Screen {
    InventoryManager,
    BatchPricer,
    ContinuousPricing,
    DataManagement,
    PullSheet,
    ShippingWorkflow,
    ProductPriceMatrix,
    InventoryEconomics,
    HttpConfiguration,
    ShippingConfiguration,
    SlabConnections,
    SlabPricing,
    PublicationConfiguration,
    Configuration,
    InventoryStrategy,
}

/// A screen as the menus and the dashboard list it, as `appNavigation`'s items.
pub struct Entry {
    pub screen: Screen,
    pub label: &'static str,
    pub description: &'static str,
    pub icon: Glyph,
}

const fn entry(
    screen: Screen,
    label: &'static str,
    description: &'static str,
    icon: Glyph,
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
        glyphs::PACKAGE,
    ),
    entry(
        Screen::BatchPricer,
        "Batch Pricer",
        "Create, price, publish, and download inventory batches",
        glyphs::LAYERS,
    ),
    entry(
        Screen::ContinuousPricing,
        "Continuous Pricing",
        "Automatic repricing runs for live inventory",
        glyphs::REPEAT,
    ),
    entry(
        Screen::SlabPricing,
        "Slab Pricing",
        "Research and price graded cards for eBay",
        glyphs::BADGE_DOLLAR_SIGN,
    ),
    entry(
        Screen::ProductPriceMatrix,
        "Price Matrix",
        "Compare one product across conditions and variants",
        icon::LAYOUT_GRID,
    ),
    entry(
        Screen::InventoryStrategy,
        "Inventory Strategy",
        "Pricing hurdle, capital turnaround, and selling speed",
        glyphs::CHART_LINE,
    ),
    entry(
        Screen::InventoryEconomics,
        "Inventory Economics",
        "Estimated cost, proceeds, and realized profit by order",
        glyphs::WALLET,
    ),
    entry(
        Screen::PullSheet,
        "Pull Sheet",
        "Upload and view pull sheets",
        icon::LIST,
    ),
    entry(
        Screen::ShippingWorkflow,
        "Shipping Export",
        "Review shipments, buy postage, and notify buyers",
        glyphs::TRUCK,
    ),
    entry(
        Screen::DataManagement,
        "Data Mgmt",
        "Refresh product lines, sets, products, and SKUs",
        glyphs::DATABASE,
    ),
];

/// The settings menu, as `settingsNavigationItems` lists it.
pub const SETTINGS: [Entry; 5] = [
    entry(
        Screen::Configuration,
        "Configuration",
        "Pricing rules and defaults",
        icon::SETTINGS,
    ),
    entry(
        Screen::PublicationConfiguration,
        "Inventory Publication",
        "Automatic publication and guardrails",
        icon::UPLOAD,
    ),
    entry(
        Screen::ShippingConfiguration,
        "Shipping Configuration",
        "Postage and shipping defaults",
        glyphs::TRUCK,
    ),
    entry(
        Screen::HttpConfiguration,
        "HTTP Configuration",
        "TCGPlayer authentication and rate limits",
        glyphs::GLOBE,
    ),
    entry(
        Screen::SlabConnections,
        "Slab data connections",
        "eBay research and Alt credentials",
        glyphs::GLOBE,
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
                    {..req.nav(&inventory_intake::url::InventoryManager { selection: Default::default() })}
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
                <a {..req.nav(&http_configuration::url::HttpSettings)}>{children}</a>
            }
            Screen::ShippingConfiguration => {
                <a {..req.nav(&shipping_configuration::url::ShippingSettings)}>
                    {children}
                </a>
            }
            Screen::ContinuousPricing => {
                <a
                    {..req.nav(&continuous_pricing::url::ContinuousPricing { view: Default::default() })}
                >
                    {children}
                </a>
            }
            Screen::DataManagement => {
                <a {..req.nav(&data_management::url::DataManagement)}>{children}</a>
            }
            Screen::SlabPricing => {
                <a {..req.nav(&slab_pricing::url::SlabPricing { choice: Default::default() })}>
                    {children}
                </a>
            }
            Screen::SlabConnections => {
                <a {..req.nav(&slab_connections::url::SlabConnections)}>{children}</a>
            }
            Screen::PublicationConfiguration => {
                <a {..req.nav(&publication_configuration::url::PublicationSettings)}>
                    {children}
                </a>
            }
            Screen::Configuration => {
                <a {..req.nav(&configuration::url::Configuration)}>{children}</a>
            }
            Screen::InventoryStrategy => {
                <a
                    {..req.nav(&inventory_strategy::url::InventoryStrategy { view: Default::default() })}
                >
                    {children}
                </a>
            }
        }
    }
}
