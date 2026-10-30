//! The app: its routes, the screens ported so far, and the relay to the React app for the rest.
use std::time::Duration;

use corten::{
    Relay,
    axum::extract::Request,
    prelude::*,
    security::Policy,
    upgrade::{SwitchOr, Upgrade},
};

use crate::{
    config,
    database::Database,
    features::{
        batch_pricer, configuration, http_configuration, inventory_economics, inventory_intake,
        product_price_matrix, publication_configuration, pull_sheet, shipping_configuration,
        shipping_export, slab_connections,
    },
    layout::{self, Static},
    legacy::{Legacy, forward},
    text::Msg,
    theme,
};

/// What the handlers share: the database, the React app behind this one, and the slab data
/// providers' client.
#[derive(Clone, FromRef)]
pub struct Shared {
    pub db: Database,
    pub legacy: Legacy,
    pub slab_providers: slab_connections::Transport,
}

impl Shared {
    pub fn from_env() -> Self {
        Shared {
            db: Database::connect_lazy(&config::database_url()),
            legacy: Legacy::new(config::legacy_origin()),
            slab_providers: slab_connections::Transport::default(),
        }
    }
}

/// Every path no ported screen claims is the React app's, its home page included. Handlers are
/// named from this module, where the routes module is declared, not from inside it.
#[corten::routes(state = Shared)]
pub mod url {
    #[route("/", get = forward, post = forward)]
    pub struct Home;

    #[route("/{*rest}", get = forward_page, post = forward_page, put = forward_page, patch = forward_page, delete = forward_page)]
    pub struct Elsewhere<'a> {
        pub rest: &'a str,
    }
}

/// The React app's JSON routes. Some (imports, slab evidence) answer after the page deadline, and
/// the batch pricing stream stays open for as long as the page does.
#[corten::routes(api = LegacyApi, state = Shared)]
pub mod api {
    #[route("/api", get = forward, post = forward)]
    pub struct LegacyApi;

    #[route("/api/{*rest}", get = forward_api, post = forward_api, put = forward_api, patch = forward_api, delete = forward_api)]
    pub struct LegacyApiRoute<'a> {
        pub rest: &'a str,
    }
}

// A route with a parameter takes its `Params`, even a catch-all whose handler reads the whole
// request, so each catch-all gets a handler of its own that passes the request on.

async fn forward_page(
    _: Params<url::Elsewhere<'_>>,
    legacy: State<Legacy>,
    upgrade: Option<Upgrade>,
    req: Request,
) -> corten::Result<SwitchOr<Relay>> {
    forward(legacy, upgrade, req).await
}

async fn forward_api(
    _: Params<api::LegacyApiRoute<'_>>,
    legacy: State<Legacy>,
    upgrade: Option<Upgrade>,
    req: Request,
) -> corten::Result<SwitchOr<Relay>> {
    forward(legacy, upgrade, req).await
}

pub fn app(shared: Shared) -> App {
    let ready = shared.db.clone();
    App::new(url::router(shared.clone()))
        .api(|routes| api::api(routes, shared.clone()).deadline(Some(Duration::from_secs(15 * 60))))
        .area(|area| pull_sheet::url::area(area, shared.clone()).components(pull_sheet::COMPONENTS))
        // A count waits on the Node app, which notes the market price when units are added.
        .area(|area| {
            inventory_intake::url::area(area, shared.clone())
                .components(inventory_intake::COMPONENTS)
                .deadline(Some(Duration::from_secs(30)))
        })
        // A seller snapshot reads the seller's whole inventory from TCGplayer before it answers,
        // and a publication plan reads the batch's results; a live stream starts at once.
        .area(|area| {
            batch_pricer::url::area(area, shared.clone())
                .components(batch_pricer::COMPONENTS)
                .deadline(Some(Duration::from_secs(5 * 60)))
        })
        .area(|area| {
            http_configuration::url::area(area, shared.clone())
                .components(http_configuration::COMPONENTS)
        })
        .area(|area| {
            inventory_economics::url::area(area, shared.clone())
                .components(inventory_economics::COMPONENTS)
        })
        // Suggested pricing reads the product's sales and models each SKU's price on the Node app.
        .area(|area| {
            product_price_matrix::url::area(area, shared.clone())
                .components(product_price_matrix::COMPONENTS)
                .deadline(Some(Duration::from_secs(2 * 60)))
        })
        // Loading the Ready to Ship queue reads every order and its market prices from TCGplayer,
        // and a bulk postage purchase waits on EasyPost for each label.
        .area(|area| {
            shipping_export::url::area(area, shared.clone())
                .components(shipping_export::COMPONENTS)
                .deadline(Some(Duration::from_secs(5 * 60)))
        })
        .area(|area| {
            shipping_configuration::url::area(area, shared.clone())
                .components(shipping_configuration::COMPONENTS)
        })
        .area(|area| {
            publication_configuration::url::area(area, shared.clone())
                .components(publication_configuration::COMPONENTS)
        })
        .area(|area| {
            configuration::url::area(area, shared.clone()).components(configuration::COMPONENTS)
        })
        // Checking a connection waits on the provider for up to 30 seconds, after its claim on it.
        .area(|area| {
            slab_connections::url::area(area, shared.clone())
                .components(slab_connections::COMPONENTS)
                .deadline(Some(Duration::from_secs(45)))
        })
        .assets(Static)
        .components(&[
            theme::TOKENS,
            layout::AppBar,
            layout::Field,
            layout::SubmitsOnChange,
        ])
        .components(corten_ui::COMPONENTS)
        .messages::<Msg>()
        // Dates are written in the visitor's zone, as the React screens' `toLocaleString`.
        .client_zone()
        // TCGplayer's product pictures.
        .policy(Policy::new().img_src("https://tcgplayer-cdn.tcgplayer.com"))
        .ready(move || {
            let db = ready.clone();
            async move { db.reachable().await }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The router and its assets build. Two components or ids with one name in different
    /// features fail the build itself since Corten 50d57b3d (corten#368), so this only checks
    /// that the app starts as the server would.
    #[tokio::test]
    async fn the_app_builds() {
        let shared = Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: slab_connections::Transport::default(),
        };
        let _ = app(shared).router();
    }

    /// The scripts' view classes (`corten/views`), which `corten check` type-checks them against.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new()
            .add::<pull_sheet::SortBy>()
            .components(pull_sheet::COMPONENTS)
            .components(batch_pricer::COMPONENTS)
            .components(shipping_export::COMPONENTS)
            .components(product_price_matrix::COMPONENTS)
            .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }
}
