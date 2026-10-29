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
    features::{http_configuration, pull_sheet},
    layout::{self, Static},
    legacy::{Legacy, forward},
    text::Msg,
    theme,
};

/// What the handlers share: the database and the React app behind this one.
#[derive(Clone, FromRef)]
pub struct Shared {
    pub db: Database,
    pub legacy: Legacy,
}

impl Shared {
    pub fn from_env() -> Self {
        Shared {
            db: Database::connect_lazy(&config::database_url()),
            legacy: Legacy::new(config::legacy_origin()),
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
        .area(|area| {
            http_configuration::url::area(area, shared.clone())
                .components(http_configuration::COMPONENTS)
        })
        .assets(Static)
        .components(&[theme::TOKENS, layout::AppBar])
        .messages::<Msg>()
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

    /// The scripts' view classes (`corten/views`), which `corten check` type-checks them against.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new()
            .add::<pull_sheet::SortBy>()
            .components(pull_sheet::COMPONENTS)
            .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }
}
