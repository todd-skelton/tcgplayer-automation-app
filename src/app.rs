//! The app: its routes, the screens ported so far, and the relay to the React app for the rest.
use std::time::Duration;

use corten::{
    Relay,
    extract::Request,
    prelude::*,
    security::Policy,
    upgrade::{SwitchOr, Upgrade},
};

use crate::{
    config,
    database::Database,
    features::{
        batch_pricer, batch_pricing, configuration, continuous_pricing, dashboard, data_management,
        http_configuration, inventory_economics, inventory_fifo, inventory_intake,
        inventory_publication, inventory_strategy, product_price_matrix, publication_configuration,
        pull_sheet, seller_order_history, shipping_configuration, shipping_export,
        slab_connections, slab_evidence, slab_pricing,
    },
    layout::{self, Static},
    legacy::{Legacy, forward},
    text::Msg,
    theme, ui,
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

/// The home page, and every path no ported screen claims, which is the React app's. Handlers are
/// named from this module, where the routes module is declared, not from inside it.
#[corten::routes(state = Shared)]
pub mod url {
    #[route("/", get = show_home)]
    pub struct Home;

    #[route("/{*rest}", get = forward_page, post = forward_page, put = forward_page, patch = forward_page, delete = forward_page)]
    pub struct Elsewhere<'a> {
        pub rest: &'a str,
    }
}

/// The JSON routes: the ones ported so far (`crate::api::ported`), and the relay to the Node app
/// for the rest. Some (imports, slab evidence) answer after the page deadline, and the batch
/// pricing stream stays open for as long as the page does.
#[corten::routes(api = LegacyApi, state = Shared)]
pub mod api {
    #[route("/api", get = forward, post = forward)]
    pub struct LegacyApi;

    #[route("/api/{*rest}", get = forward_api, post = forward_api, put = forward_api, patch = forward_api, delete = forward_api)]
    pub struct LegacyApiRoute<'a> {
        pub rest: &'a str,
    }
}

use dashboard::show as show_home;

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

/// The API's own failures (an unknown method, the deadline, the Node app out of reach) in the Node
/// app's shape.
fn node_shaped<P: corten::Route>(api: corten::Api<P>) -> corten::Api<P> {
    api.errors(|_, message| serde_json::json!({ "error": message }))
}

pub fn app(shared: Shared) -> App {
    let ready = shared.db.clone();
    let db = shared.db.clone();
    let app = App::new(url::router(shared.clone()))
        .api(|routes| {
            let routes =
                api::api(routes, shared.clone()).deadline(Some(Duration::from_secs(15 * 60)));
            node_shaped(crate::api::ported(routes, &shared))
        })
        .area(|area| pull_sheet::url::area(area, shared.clone()).components(pull_sheet::COMPONENTS))
        // Adding units to a count reads the card's market price from TCGplayer, giving up after 3 s.
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
        // A refresh reads the seller's whole inventory from TCGplayer before it answers, and marking
        // the inventory due runs a scheduler cycle after it.
        .area(|area| {
            continuous_pricing::url::area(area, shared.clone())
                .components(continuous_pricing::COMPONENTS)
                .deadline(Some(Duration::from_secs(5 * 60)))
        })
        // A catalog job reads TCGplayer for as long as it takes (every product of a product line can
        // take many minutes); the proxy in front waits an hour.
        .area(|area| {
            data_management::url::area(area, shared.clone())
                .components(data_management::COMPONENTS)
                .deadline(Some(Duration::from_secs(60 * 60)))
        })
        .area(|area| {
            http_configuration::url::area(area, shared.clone())
                .components(http_configuration::COMPONENTS)
        })
        .area(|area| {
            inventory_economics::url::area(area, shared.clone())
                .components(inventory_economics::COMPONENTS)
        })
        // Refreshing reads the seller's whole inventory from TCGplayer before it answers; the
        // dashboard's first build models every in-stock SKU.
        .area(|area| {
            inventory_strategy::url::area(area, shared.clone())
                .components(inventory_strategy::COMPONENTS)
                .deadline(Some(Duration::from_secs(5 * 60)))
        })
        // Suggested pricing reads the product's sales from TCGplayer and models each SKU's price.
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
                // Its Pull Sheet and Pack steps show the pull sheet's items.
                .components(pull_sheet::ITEMS)
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
        // Looking a certificate up waits on Alt when it was never looked up.
        .area(|area| {
            slab_pricing::url::area(area, shared.clone())
                .components(slab_pricing::COMPONENTS)
                .deadline(Some(Duration::from_secs(45)))
        })
        // Checking a connection waits on the provider for up to 30 seconds, after its claim on it.
        .area(|area| {
            slab_connections::url::area(area, shared.clone())
                .components(slab_connections::COMPONENTS)
                .deadline(Some(Duration::from_secs(45)))
        })
        .assets(Static)
        .components(&[theme::TOKENS])
        .components(ui::COMPONENTS)
        .components(&[
            layout::AppBar,
            layout::Layout,
            layout::SubmitsOnChange,
            layout::DialogNotSent,
        ])
        .components(corten_ui::COMPONENTS)
        .components(dashboard::COMPONENTS)
        .messages::<Msg>()
        .error_page(layout::error_page, ())
        // Dates are written in the visitor's zone, as the React screens' `toLocaleString`.
        .zoned_dates()
        // TCGplayer's product pictures.
        .policy(Policy::new().img_src("https://tcgplayer-cdn.tcgplayer.com"))
        .task("forecast evidence backfill", {
            let db = shared.db.clone();
            move |signal| inventory_strategy::backfill::run(db, signal)
        })
        // The app bar's auth cookie warning, read beside each full load's handler.
        .layout_read(layout::AuthCookieMissing(shared.db.clone()))
        .ready(move || {
            let db = ready.clone();
            async move { db.reachable().await }
        });
    // Node's worker prices the batches until cutover.
    let app = switched(app, "inventory batch pricing worker", {
        let db = db.clone();
        batch_pricing::worker::on()
            .then_some(move |signal| batch_pricing::worker::start(db, signal))
    });
    // Node's scheduler queues the batches until cutover.
    let app = switched(app, "continuous pricing scheduler", {
        let db = db.clone();
        continuous_pricing::scheduler::on()
            .then_some(move |signal| continuous_pricing::scheduler::run(db, signal))
    });
    // Node's worker records the order history, replays FIFO and estimates costs until cutover.
    let app = switched(app, "seller order history worker", {
        let db = db.clone();
        seller_order_history::worker::on()
            .then_some(move |signal| seller_order_history::worker::run(db, signal))
    });
    // Node's worker refreshes the slab evidence until cutover; both read Alt and eBay.
    let app = switched(app, "slab evidence worker", {
        let db = db.clone();
        let providers = slab_evidence::worker::Providers {
            transport: shared.slab_providers.clone(),
            gate: slab_connections::DatabaseGate(db.clone()),
        };
        slab_evidence::worker::on()
            .then_some(move |signal| slab_evidence::worker::run(db, providers, signal))
    });
    // Node's worker publishes to Seller Portal until cutover; this one writes there too when on.
    let app = switched(app, "inventory publication worker", {
        let db = db.clone();
        inventory_publication::worker::on()
            .then_some(move |signal| inventory_publication::worker::run(db, signal))
    });
    // It reads TCGplayer and writes only to its log.
    let app = switched(app, "seller order history shadow", {
        let db = db.clone();
        seller_order_history::shadow::log_path()
            .map(|log| move |signal| seller_order_history::shadow::run(db, log, signal))
    });
    // It reads the database and writes only to its log.
    let app = switched(app, "fifo replay shadow", {
        let db = db.clone();
        inventory_fifo::shadow::log_path()
            .map(|log| move |signal| inventory_fifo::shadow::run(db, log, signal))
    });
    // It reads the database and writes only to its log.
    switched(app, "estimated purchase cost shadow", {
        inventory_economics::estimate::log_path()
            .map(|log| move |signal| inventory_economics::estimate::run(db, log, signal))
    })
}

/// A task the configuration turns on or off: one that is off is not registered, and the log says
/// so, as Corten's guide shows for a switched task (corten#503).
fn switched<F, Fut>(app: App, name: &'static str, task: Option<F>) -> App
where
    F: FnOnce(corten::Signal) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    match task {
        Some(task) => app.task(name, task),
        None => {
            println!("Task {name} is off");
            app
        }
    }
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

    /// A failed page is drawn in the app's layout, as the React app's `ErrorBoundary` was in its
    /// theme: here a path no screen claims, relayed to a Node app that does not answer. It reads
    /// no database (the pool points nowhere).
    #[tokio::test]
    async fn a_failed_page_is_in_the_layout() {
        let shared = Shared {
            db: Database::connect_lazy("postgresql://localhost:1/unused"),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: slab_connections::Transport::default(),
        };
        let answer = app(shared)
            .test()
            .get(&corten::Local::parse("/no-such-screen").unwrap())
            .await;
        assert_eq!(answer.status(), corten::http::StatusCode::BAD_GATEWAY);
        let page = answer.text();
        assert!(
            page.contains("<title>Something went wrong | TCGPlayer Automation</title>"),
            "{page}"
        );
        assert!(
            page.contains(">TCGPlayer Automation</a>"),
            "the app bar: {page}"
        );
        assert!(page.contains("Go to the home page"), "{page}");
    }

    /// What carries buyers' addresses or a provider's status is kept by nothing, as React's
    /// `Cache-Control: no-store` said: the packing slips PDF and the slab connections page. A
    /// failure under it is not kept either, so the database need not answer.
    #[tokio::test]
    async fn private_answers_are_not_stored() {
        let shared = Shared {
            db: Database::connect_lazy("postgresql://localhost:1/unused"),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: slab_connections::Transport::default(),
        };
        let client = app(shared).test();
        let answers = [
            (
                "packing slips",
                client
                    .get(&shipping_export::url::PackingSlips { open: Some(true) })
                    .await,
            ),
            (
                "slab connections",
                client.get(&slab_connections::url::SlabConnections).await,
            ),
        ];
        for (page, answer) in answers {
            assert_eq!(answer.headers()["cache-control"], "no-store", "{page}");
        }
    }

    /// A page read from the dev database (`.env`), once with the browser's zone (`corten-zone`)
    /// and once without: its dates are the visitor's, else UTC and marked so. Reads only; the
    /// router starts none of the app's tasks, and Node is not reached.
    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn dates_are_written_in_the_visitors_zone() {
        crate::config::load_env();
        let read = |path: &'static str, zone: Option<&'static str>| async move {
            let shared = Shared {
                db: Database::connect_lazy(&crate::config::database_url()),
                legacy: Legacy::new("http://localhost:1".into()),
                slab_providers: slab_connections::Transport::default(),
            };
            let client = app(shared).test();
            let mut call = client.get(&corten::Local::parse(path).unwrap());
            if let Some(zone) = zone {
                call = call.cookie("corten-zone", zone);
            }
            call.await.text().to_owned()
        };
        let mut zoned = 0;
        for path in ["/inventory-strategy", "/pending-inventory-pricer"] {
            let (utc, chicago) = (
                read(path, None).await,
                read(path, Some("America/Chicago")).await,
            );
            // Before the browser names its zone a date says it is UTC; after, it is the zone's own.
            let marked = |page: &str| page.matches(" UTC").count();
            println!(
                "{path}: {} dates in UTC, {} with the zone",
                marked(&utc),
                marked(&chicago)
            );
            assert_eq!(marked(&chicago), 0, "{path}");
            assert!(marked(&utc) == 0 || chicago.contains(" GMT-"), "{path}");
            zoned += marked(&utc);
        }
        assert!(zoned > 0, "no page wrote a date");
    }

    /// Every screen, read from the dev database (`.env`) under the check every debug build runs: a
    /// page that renders a component whose stylesheet it does not link (one listed in another area
    /// only) is a 500 there, where a release build serves it unstyled (corten#619). Each screen is read
    /// empty and, where the database has one, with a batch, sheet, slab or order chosen. Reads
    /// only, as above; the slab providers are a closed port, and no screen here asks TCGplayer
    /// (the price matrix with a product chosen would, so it is read without one).
    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn every_screen_links_the_stylesheets_of_what_it_renders() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let shared = Shared {
            db: db.clone(),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: slab_connections::Transport::to(
                "http://127.0.0.1:1",
                "http://127.0.0.1:1",
            ),
        };
        let client = app(shared).test();
        let chosen = chosen_screens(&db).await;
        let steps = [
            "load-orders",
            "pull-sheet",
            "buy-postage",
            "print",
            "pack",
            "ship",
        ]
        .map(|step| format!("/shipping-export?step={step}"));
        let screens = [
            "/",
            "/inventory-manager",
            "/pending-inventory-pricer",
            "/continuous-pricing",
            "/slab-pricing",
            "/slab-connections",
            "/product-price-matrix",
            "/inventory-economics",
            "/inventory-strategy",
            "/pull-sheet",
            "/data-management",
            "/configuration",
            "/publication-configuration",
            "/shipping-configuration",
            "/http-configuration",
            "/shipping-export/order-labels",
            "/shipping-export?step=pack&view=list",
        ]
        .map(String::from);
        assert!(
            chosen.len() >= 10,
            "the dev database has too little to choose: {chosen:#?}"
        );
        let mut failed = Vec::new();
        for path in screens.into_iter().chain(steps).chain(chosen) {
            let answer = match path.strip_prefix(PATCH) {
                Some(view) => {
                    let view = corten::Local::parse(view).unwrap();
                    client.get(&view).mode(corten::Mode::Action).await
                }
                None => client.get(&corten::Local::parse(&path).unwrap()).await,
            };
            if !answer.status().is_success() {
                let status = answer.status();
                let body = answer.text();
                let said = body
                    .find("renders ")
                    .map_or("", |at| &body[at..(at + 200).min(body.len())]);
                failed.push(format!("{path}: {status} {said}"));
            }
        }
        assert!(failed.is_empty(), "{failed:#?}");
    }

    /// A view only the runtime asks for (it patches it into the page), marked so the test asks
    /// as the runtime does; without the header it redirects to its screen.
    fn patch(path: String) -> String {
        format!("{PATCH}{path}")
    }

    const PATCH: &str = "patch:";

    /// The screens that show something chosen from the database: the newest batch, pull sheet,
    /// slab and workflow order, and a product line with one of its sets.
    async fn chosen_screens(db: &Database) -> Vec<String> {
        use corten::Route;
        let one = |sql: &'static str| async move {
            sqlx::query_as::<_, (String, String)>(sql)
                .fetch_optional(&db.0)
                .await
                .expect("the dev database answers")
        };
        let mut chosen = Vec::new();
        if let Some((batch, _)) = one(
            "SELECT b.batch_number::text, '' FROM inventory_batches b ORDER BY b.batch_number DESC LIMIT 1",
        )
        .await
        {
            let batch: i32 = batch.parse().unwrap();
            chosen.push(batch_pricer::url::BatchPricer::batch(batch).href());
            chosen.push(patch(
                inventory_strategy::url::Analysis {
                    batch,
                    view: Default::default(),
                }
                .href(),
            ));
        }
        if let Some((id, _)) = one(
            "SELECT s.pull_sheet_id::text, '' FROM pull_sheets s ORDER BY s.pull_sheet_id DESC LIMIT 1",
        )
        .await
        {
            chosen.push(
                pull_sheet::url::PullSheet {
                    id: id.parse().unwrap(),
                    filters: Default::default(),
                }
                .href(),
            );
        }
        if let Some((order, _)) = one(
            "SELECT workflow_json->'orders'->0->>'Order #', '' FROM shipping_workflows
             WHERE workflow_key = 'current' AND workflow_json->'orders'->0 ? 'Order #'",
        )
        .await
        {
            chosen.push(shipping_export::url::OrderLabels { order: Some(order) }.href());
            // The batch's packing slips: a 404 when there is no workflow to print.
            chosen.push(shipping_export::url::PackingSlips { open: None }.href());
        }
        if let Some((grader, cert)) =
            one("SELECT grader, certificate_number FROM slab_identities LIMIT 1").await
        {
            let slab = slab_pricing::url::Choice {
                grader: Some(grader),
                cert: Some(cert),
                ..Default::default()
            };
            for choice in [
                slab.clone(),
                slab_pricing::url::Choice {
                    supply: Some(true),
                    ..slab.clone()
                },
                slab_pricing::url::Choice {
                    maintenance: Some(true),
                    outcomes: Some(true),
                    publication: Some(true),
                    ..slab.clone()
                },
            ] {
                chosen.push(slab_pricing::url::SlabPricing::at(&choice).href());
            }
            chosen.push(
                slab_pricing::url::Evidence {
                    choice: slab.clone(),
                }
                .href(),
            );
            chosen.push(slab_pricing::url::MaintenanceStatus { choice: slab }.href());
        }
        if let Some((line, set)) = one(
            "SELECT s.category_id::text, s.set_name_id::text FROM category_sets s ORDER BY s.set_name_id DESC LIMIT 1",
        )
        .await
        {
            let (line, set) = (Some(line.parse().unwrap()), Some(set.parse().unwrap()));
            chosen.push(
                product_price_matrix::url::ProductPriceMatrix {
                    choice: product_price_matrix::url::Choice {
                        line,
                        set,
                        ..Default::default()
                    },
                }
                .href(),
            );
            chosen.push(
                inventory_intake::url::InventoryManager {
                    selection: inventory_intake::url::Selection {
                        line,
                        set,
                        ..Default::default()
                    },
                }
                .href(),
            );
        }
        chosen.push(patch(
            inventory_intake::url::Batches {
                selection: Default::default(),
            }
            .href(),
        ));
        chosen.push(
            configuration::url::CalibrationReport {
                window: Default::default(),
            }
            .href(),
        );
        chosen.push(
            configuration::url::ShippingReport {
                window: Default::default(),
            }
            .href(),
        );
        chosen
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
