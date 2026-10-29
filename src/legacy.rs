//! The React Router app in `app/`, behind this one while the port runs. Every path no ported
//! screen serves (its pages, its JSON routes, its event streams, Vite's assets and HMR socket in
//! development) is passed to it as it came and its answer passed back as it comes, so one origin
//! serves both apps and the Node app needs no change to sit behind this one.
use corten::{
    Relay,
    axum::{
        body::Body,
        extract::{Request, State},
        http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    },
    upgrade::{Switch, SwitchOr, Upgrade},
};
use futures_util::TryStreamExt;

/// Headers that belong to one connection, not to the request or answer they travel with.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
];

#[derive(Clone)]
pub struct Legacy {
    http: reqwest::Client,
    origin: String,
}

impl Legacy {
    pub fn new(origin: String) -> Self {
        // No redirects followed: the browser follows them, so the address bar stays right.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("an HTTP client");
        Legacy {
            http,
            origin: origin.trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, uri: &Uri) -> String {
        format!(
            "{}{}",
            self.origin,
            uri.path_and_query().map_or("/", |p| p.as_str())
        )
    }
}

/// The request's headers as the Node app should see them. `Host` stays the browser's, as nginx
/// sends it, since React Router checks a form's `Origin` against it; `Upgrade` stays for a socket.
fn forwarded(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

fn has_body(headers: &HeaderMap) -> bool {
    headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|n| n != "0")
}

fn unreachable(error: reqwest::Error) -> corten::Error {
    corten::Error::new(format!("the legacy app did not answer: {error}"))
        .with_status(StatusCode::BAD_GATEWAY)
}

/// Any method at any path the port does not serve yet.
pub async fn forward(
    State(legacy): State<Legacy>,
    upgrade: Option<Upgrade>,
    req: Request,
) -> corten::Result<SwitchOr<Relay>> {
    let (parts, body) = req.into_parts();
    let url = legacy.url(&parts.uri);
    let headers = forwarded(&parts.headers);
    if let Some(upgrade) = upgrade {
        return tunnel(&legacy, upgrade, url, headers).await;
    }
    let mut request = legacy
        .http
        .request(parts.method.clone(), url)
        .headers(headers);
    if has_body(&parts.headers) {
        request = request.body(reqwest::Body::wrap_stream(
            body.into_data_stream().map_err(std::io::Error::other),
        ));
    }
    let answer = request.send().await.map_err(unreachable)?;
    Ok(SwitchOr::Answer(relay(answer)))
}

fn relay(answer: reqwest::Response) -> Relay {
    let status = answer.status();
    let mut headers = answer.headers().clone();
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    Relay::new(status, headers, Body::from_stream(answer.bytes_stream()))
}

/// A WebSocket (Vite's hot reload in development): the Node app's switch, then bytes both ways.
async fn tunnel(
    legacy: &Legacy,
    upgrade: Upgrade,
    url: String,
    headers: HeaderMap,
) -> corten::Result<SwitchOr<Relay>> {
    let mut headers = headers;
    headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    let answer = legacy
        .http
        .request(Method::GET, url)
        .headers(headers)
        .send()
        .await
        .map_err(unreachable)?;
    if answer.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Ok(SwitchOr::Answer(relay(answer)));
    }
    let switched = answer.headers().clone();
    let mut upstream = answer.upgrade().await.map_err(unreachable)?;
    let switch: Switch = upgrade.switch(switched, move |mut stream, signal| async move {
        tokio::select! {
            _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream) => {}
            _ = signal.aborted() => {}
        }
    });
    Ok(switch.into())
}

/// The screens the React app still serves, as link-only routes so the app bar names each by a
/// type. A screen leaves this list when its port lands, and every link to it then fails to compile
/// until it names the ported route.
pub mod screens {
    use corten::{Href, Route, view::AttrValue};

    #[derive(Route)]
    #[route("/")]
    pub struct Dashboard;
    #[derive(Route)]
    #[route("/inventory-manager")]
    pub struct InventoryManager;
    #[derive(Route)]
    #[route("/pending-inventory-pricer")]
    pub struct PendingInventoryPricer;
    #[derive(Route)]
    #[route("/continuous-pricing")]
    pub struct ContinuousPricing;
    #[derive(Route)]
    #[route("/slab-pricing")]
    pub struct SlabPricing;
    #[derive(Route)]
    #[route("/product-price-matrix")]
    pub struct ProductPriceMatrix;
    #[derive(Route)]
    #[route("/inventory-strategy")]
    pub struct InventoryStrategy;
    #[derive(Route)]
    #[route("/inventory-economics")]
    pub struct InventoryEconomics;
    #[derive(Route)]
    #[route("/shipping-export")]
    pub struct ShippingExport;
    #[derive(Route)]
    #[route("/data-management")]
    pub struct DataManagement;
    #[derive(Route)]
    #[route("/configuration")]
    pub struct Configuration;
    #[derive(Route)]
    #[route("/publication-configuration")]
    pub struct PublicationConfiguration;
    #[derive(Route)]
    #[route("/shipping-configuration")]
    pub struct ShippingConfiguration;
    #[derive(Route)]
    #[route("/http-configuration")]
    pub struct HttpConfiguration;
    #[derive(Route)]
    #[route("/slab-connections")]
    pub struct SlabConnections;

    /// One of them, for lists of screens (the app bar's).
    #[derive(Clone, Copy)]
    pub enum Screen {
        InventoryManager,
        PendingInventoryPricer,
        ContinuousPricing,
        SlabPricing,
        ProductPriceMatrix,
        InventoryStrategy,
        InventoryEconomics,
        ShippingExport,
        DataManagement,
        Configuration,
        PublicationConfiguration,
        ShippingConfiguration,
        HttpConfiguration,
        SlabConnections,
    }

    impl Href for Screen {
        fn with_href<T>(&self, f: impl FnOnce(&str) -> T) -> T {
            match self {
                Screen::InventoryManager => InventoryManager.with_href(f),
                Screen::PendingInventoryPricer => PendingInventoryPricer.with_href(f),
                Screen::ContinuousPricing => ContinuousPricing.with_href(f),
                Screen::SlabPricing => SlabPricing.with_href(f),
                Screen::ProductPriceMatrix => ProductPriceMatrix.with_href(f),
                Screen::InventoryStrategy => InventoryStrategy.with_href(f),
                Screen::InventoryEconomics => InventoryEconomics.with_href(f),
                Screen::ShippingExport => ShippingExport.with_href(f),
                Screen::DataManagement => DataManagement.with_href(f),
                Screen::Configuration => Configuration.with_href(f),
                Screen::PublicationConfiguration => PublicationConfiguration.with_href(f),
                Screen::ShippingConfiguration => ShippingConfiguration.with_href(f),
                Screen::HttpConfiguration => HttpConfiguration.with_href(f),
                Screen::SlabConnections => SlabConnections.with_href(f),
            }
        }
    }

    /// `href={screen}`: a route's derive writes its own attribute, an enum of routes does not
    /// (corten issue filed by the port), so this writes the URL its `Href` gives.
    impl AttrValue for Screen {
        fn write_attr(&self, name: &str, out: &mut String) {
            self.with_href(|href| href.write_attr(name, out))
        }
    }
}
