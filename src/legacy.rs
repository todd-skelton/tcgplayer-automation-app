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

    /// What one of the Node app's JSON routes answers (`/api/...`), read as `T`: for a part of a
    /// ported screen whose computation is still the Node app's. An error is the message the route
    /// gave (`{"error": ".."}`), or why there was none to read.
    pub async fn read<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let answer = self
            .http
            .get(format!("{}{path}", self.origin))
            .send()
            .await
            .map_err(|_| "The Node app did not answer.".to_owned())?;
        Self::answer(answer).await
    }

    /// What one of the Node app's JSON routes answers to `body` posted as JSON: for a write whose
    /// rules are still the Node app's. An error is the message the route gave, or why there was
    /// none to read.
    pub async fn send<B: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, String> {
        let body = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let answer = self
            .http
            .post(format!("{}{path}", self.origin))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| "The Node app did not answer.".to_owned())?;
        Self::answer(answer).await
    }

    /// What one of the Node app's routes answers to deleting `path`.
    pub async fn delete<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let answer = self
            .http
            .delete(format!("{}{path}", self.origin))
            .send()
            .await
            .map_err(|_| "The Node app did not answer.".to_owned())?;
        Self::answer(answer).await
    }

    /// What one of the Node app's routes answers to a file posted as `multipart/form-data` under
    /// `field`, named `file_name`: an upload whose import is still the Node app's.
    pub async fn send_file<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        field: &'static str,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<T, String> {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_owned())
            .mime_str("text/csv")
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new().part(field, part);
        let answer = self
            .http
            .post(format!("{}{path}", self.origin))
            .multipart(form)
            .send()
            .await
            .map_err(|_| "The Node app did not answer.".to_owned())?;
        Self::answer(answer).await
    }

    async fn answer<T: serde::de::DeserializeOwned>(
        answer: reqwest::Response,
    ) -> Result<T, String> {
        let ok = answer.status().is_success();
        let body = answer
            .bytes()
            .await
            .map_err(|_| "The Node app stopped answering.".to_owned())?;
        if ok {
            return serde_json::from_slice(&body)
                .map_err(|_| "The Node app answered something this page cannot read.".to_owned());
        }
        #[derive(serde::Deserialize)]
        struct Refusal {
            error: String,
        }
        Err(serde_json::from_slice::<Refusal>(&body)
            .map_or_else(|_| "The Node app could not do it.".to_owned(), |r| r.error))
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

    /// One of them, for lists of screens (the app bar's).
    #[derive(Clone, Copy)]
    pub enum Screen {
        ContinuousPricing,
        SlabPricing,
        ProductPriceMatrix,
        InventoryStrategy,
        InventoryEconomics,
        ShippingExport,
        DataManagement,
    }

    impl Href for Screen {
        fn with_href<T>(&self, f: impl FnOnce(&str) -> T) -> T {
            match self {
                Screen::ContinuousPricing => ContinuousPricing.with_href(f),
                Screen::SlabPricing => SlabPricing.with_href(f),
                Screen::ProductPriceMatrix => ProductPriceMatrix.with_href(f),
                Screen::InventoryStrategy => InventoryStrategy.with_href(f),
                Screen::InventoryEconomics => InventoryEconomics.with_href(f),
                Screen::ShippingExport => ShippingExport.with_href(f),
                Screen::DataManagement => DataManagement.with_href(f),
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
