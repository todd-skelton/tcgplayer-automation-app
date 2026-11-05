//! The Node app in `app/`, behind this one until cutover. Every path this app does not serve (the
//! Node app's JSON routes, Vite's assets and HMR socket in development) is passed to it as it
//! came and its answer passed back as it comes, so one origin serves both apps and the Node app
//! needs no change to sit behind this one.
use corten::{
    Relay,
    axum::{
        body::Body,
        extract::{Request, State},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
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

    /// What one of the Node app's JSON routes answers (`/api/...`) with `query` added to the path's
    /// query string, read as `T`: what a parity test compares a ported read with. An error is the
    /// message the route gave (`{"error": ".."}`), or why there was none to read.
    #[cfg(test)]
    pub async fn read_with<T: serde::de::DeserializeOwned, Q: serde::Serialize>(
        &self,
        path: &str,
        query: &Q,
    ) -> Result<T, String> {
        let answer = self
            .http
            .get(format!("{}{path}", self.origin))
            .query(query)
            .send()
            .await
            .map_err(|_| "The Node app did not answer.".to_owned())?;
        Self::answer(answer).await
    }

    #[cfg(test)]
    async fn answer<T: serde::de::DeserializeOwned>(
        answer: reqwest::Response,
    ) -> Result<T, String> {
        let status = answer.status();
        let body = answer
            .bytes()
            .await
            .map_err(|_| "The Node app stopped answering.".to_owned())?;
        if status.is_success() {
            return serde_json::from_slice(&body)
                .map_err(|_| "The Node app answered something this page cannot read.".to_owned());
        }
        #[derive(serde::Deserialize)]
        struct Said {
            error: String,
        }
        Err(serde_json::from_slice::<Said>(&body)
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
    if let Some(upgrade) = upgrade {
        let url = legacy.url(req.uri());
        let headers = forwarded(req.headers());
        return tunnel(&legacy, upgrade, url, headers).await;
    }
    relay_request(&legacy, req).await.map(SwitchOr::Answer)
}

/// The request sent to the Node app, and its answer as it comes: for a JSON route that answers
/// some requests itself (`relay.into()` is its `JsonResponse`).
pub async fn relay_request(legacy: &Legacy, req: Request) -> corten::Result<Relay> {
    let (parts, body) = req.into_parts();
    let url = legacy.url(&parts.uri);
    let headers = forwarded(&parts.headers);
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
    Ok(relay(answer))
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
