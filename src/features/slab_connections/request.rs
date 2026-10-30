//! The one way this app reads a slab data provider, ported from
//! `connections/providerRequest.server.ts`: a fixed origin and path per provider, read-only, no
//! redirects followed, at most 30 seconds and 2 MB, three attempts, and a [`Gate`] that lets one
//! request at a time reach each provider, from any process, and keeps the provider's cooldown.
use std::{future::Future, time::Duration};

use chrono::{DateTime, TimeDelta, Utc};
use futures_util::FutureExt;
use reqwest::{
    Method, Url,
    header::{self, HeaderMap, HeaderValue},
};
use tokio::time::{Instant, sleep, timeout_at};

use super::provider::{Provider, Status};

/// The longest a request may take, from its claim on the provider to its last byte.
pub const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY: usize = 2 * 1024 * 1024;
/// The least time between two requests to a provider, and the wait before a retry.
const GAP: Duration = Duration::from_secs(2);
/// The wait after a provider failed or answered what the adapter cannot read.
const COOLDOWN_AFTER_FAILURE: Duration = Duration::from_secs(30);

const ALT_ORIGIN: &str = "https://alt-platform-server.production.internal.onlyalt.com";
const EBAY_ORIGIN: &str = "https://www.ebay.com";

/// The credential a request may use, held until it is released.
pub struct Lease {
    pub id: String,
    pub revision: i32,
    pub secret: String,
    pub user_agent: String,
}

/// Who may reach a provider now. `claim` answers the saved credential, or why there is none to
/// use (`NotConfigured`, `ReconnectRequired`, `Busy` while another request or the cooldown runs);
/// `release` stores how the request went and when the provider may be asked again.
pub trait Gate: Clone + Send + Sync + 'static {
    fn claim(&self, provider: Provider) -> impl Future<Output = Result<Lease, Status>> + Send;

    fn release(
        &self,
        provider: Provider,
        lease: &Lease,
        status: Status,
        retry_at: DateTime<Utc>,
    ) -> impl Future<Output = Result<(), Status>> + Send;
}

/// What to ask a provider: a path on its origin, and a body for a POST.
pub struct Ask {
    pub path: String,
    pub body: Option<String>,
    pub timeout: Duration,
}

impl Ask {
    pub fn get(path: impl Into<String>) -> Self {
        Ask {
            path: path.into(),
            body: None,
            timeout: TIMEOUT,
        }
    }

    pub fn post(path: impl Into<String>, body: String) -> Self {
        Ask {
            body: Some(body),
            ..Ask::get(path)
        }
    }
}

/// Reads an answer the adapter understands, or says what the answer means for the connection.
pub type Check = fn(&str) -> Result<(), Status>;

#[derive(Clone)]
pub struct Transport {
    http: reqwest::Client,
    alt: Url,
    ebay_research: Url,
}

impl Default for Transport {
    fn default() -> Self {
        Transport::to(ALT_ORIGIN, EBAY_ORIGIN)
    }
}

impl Transport {
    fn to(alt: &str, ebay_research: &str) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds");
        Transport {
            http,
            alt: Url::parse(alt).expect("a provider origin is a URL"),
            ebay_research: Url::parse(ebay_research).expect("a provider origin is a URL"),
        }
    }

    /// Asks `provider` and answers its body once `check` accepts it. Every failure is a
    /// [`Status`], never the transport's error, which can hold the credential.
    ///
    /// It claims the provider's lease and releases it, so a handler runs it inside
    /// `Signal::finish`, which finishes it when the handler is dropped. `cancel` resolving (the
    /// work's signal) stops the request, and the lease is released as cancelled.
    pub async fn request<G: Gate>(
        &self,
        gate: &G,
        provider: Provider,
        ask: Ask,
        check: Check,
        cancel: impl Future<Output = ()> + Send,
    ) -> Result<String, Status> {
        self.clone()
            .run(gate.clone(), provider, ask, check, cancel)
            .await
    }

    async fn run<G: Gate>(
        self,
        gate: G,
        provider: Provider,
        ask: Ask,
        check: Check,
        cancel: impl Future<Output = ()> + Send,
    ) -> Result<String, Status> {
        let url = self.url(provider, &ask.path)?;
        if ask.timeout.is_zero() {
            return Err(Status::InvalidResponse);
        }
        let deadline = Instant::now() + ask.timeout.min(TIMEOUT);
        let mut cancel = Box::pin(cancel);
        if (&mut cancel).now_or_never().is_some() {
            return Err(Status::Cancelled);
        }
        let lease = gate.claim(provider).await?;
        let mut retry_at = DateTime::<Utc>::MIN_UTC;
        let outcome = if (&mut cancel).now_or_never().is_some() {
            Err(Status::Cancelled)
        } else {
            let attempts =
                self.attempts(provider, &url, &ask, &lease, check, deadline, &mut retry_at);
            tokio::select! {
                biased;
                () = &mut cancel => Err(Status::Cancelled),
                answered = timeout_at(deadline, attempts) => answered.unwrap_or(Err(Status::Cancelled)),
            }
        };
        let status = outcome.as_ref().err().copied().unwrap_or(Status::Connected);
        let cooldown = match status {
            Status::Unavailable | Status::InvalidResponse => COOLDOWN_AFTER_FAILURE,
            _ => GAP,
        };
        gate.release(
            provider,
            &lease,
            status,
            retry_at.max(after(Utc::now(), cooldown)),
        )
        .await?;
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    async fn attempts(
        &self,
        provider: Provider,
        url: &Url,
        ask: &Ask,
        lease: &Lease,
        check: Check,
        deadline: Instant,
        retry_at: &mut DateTime<Utc>,
    ) -> Result<String, Status> {
        let headers = headers(provider, lease)?;
        let method = if ask.body.is_some() {
            Method::POST
        } else {
            Method::GET
        };
        for attempt in 0..3u32 {
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .headers(headers.clone());
            if let Some(body) = &ask.body {
                request = request.body(body.clone());
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(_) if attempt == 2 => return Err(Status::Unavailable),
                Err(_) => {
                    sleep(GAP * (attempt + 1)).await;
                    continue;
                }
            };
            let code = response.status().as_u16();
            if matches!(code, 301 | 302 | 303 | 307 | 308 | 401 | 403) {
                return Err(Status::ReconnectRequired);
            }
            if matches!(code, 429 | 502 | 503 | 504) {
                let header = response.headers().get(header::RETRY_AFTER);
                let wait = retry_after(header.and_then(|v| v.to_str().ok()), Utc::now());
                *retry_at = after(Utc::now(), wait);
                if attempt == 2 || wait >= deadline.saturating_duration_since(Instant::now()) {
                    return Err(if code == 429 {
                        Status::RateLimited
                    } else {
                        Status::Unavailable
                    });
                }
                sleep(wait).await;
                continue;
            }
            if !response.status().is_success() {
                return Err(Status::InvalidResponse);
            }
            let body = read_body(response).await?;
            check(&body)?;
            return Ok(body);
        }
        Err(Status::Unavailable)
    }

    /// The provider's URL for `path`, refused unless it stays on the provider's origin and is one
    /// of the paths this app reads.
    fn url(&self, provider: Provider, path: &str) -> Result<Url, Status> {
        let origin = match provider {
            Provider::Alt => &self.alt,
            Provider::EbayResearch => &self.ebay_research,
        };
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(Status::InvalidResponse);
        }
        let url = origin.join(path).map_err(|_| Status::InvalidResponse)?;
        let read_here = match provider {
            Provider::Alt => url.path().starts_with("/graphql/"),
            Provider::EbayResearch => url.path() == "/sh/research/api/search",
        };
        let stays = url.origin() == origin.origin()
            && url.username().is_empty()
            && url.password().is_none();
        if stays && read_here {
            Ok(url)
        } else {
            Err(Status::InvalidResponse)
        }
    }
}

/// The headers a signed-in browser sends each provider. A credential the header cannot hold
/// must be replaced.
fn headers(provider: Provider, lease: &Lease) -> Result<HeaderMap, Status> {
    let secret = |text: String| {
        let mut value =
            HeaderValue::from_bytes(text.as_bytes()).map_err(|_| Status::ReconnectRequired)?;
        value.set_sensitive(true);
        Ok::<_, Status>(value)
    };
    let mut headers = HeaderMap::new();
    match provider {
        Provider::Alt => {
            headers.insert(
                header::AUTHORIZATION,
                secret(format!("Bearer {}", lease.secret))?,
            );
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            headers.insert(header::ORIGIN, HeaderValue::from_static("https://alt.xyz"));
            headers.insert(
                header::REFERER,
                HeaderValue::from_static("https://alt.xyz/"),
            );
        }
        Provider::EbayResearch => {
            headers.insert(header::COOKIE, secret(lease.secret.clone())?);
            let agent =
                HeaderValue::from_str(&lease.user_agent).map_err(|_| Status::ReconnectRequired)?;
            headers.insert(header::USER_AGENT, agent);
            headers.insert(
                header::REFERER,
                HeaderValue::from_static("https://www.ebay.com/sh/research"),
            );
        }
    }
    Ok(headers)
}

/// The body, refused past 2 MB, and as a sign-in page (markup) when it starts with `<`.
async fn read_body(mut response: reqwest::Response) -> Result<String, Status> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Status::Unavailable)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BODY {
            return Err(Status::InvalidResponse);
        }
        if is_markup(&bytes) {
            return Err(Status::ReconnectRequired);
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_markup(bytes: &[u8]) -> bool {
    bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'<')
}

/// How long a provider asked to be left alone (`Retry-After`, in seconds or as a date), and at
/// least the gap between requests.
pub fn retry_after(header: Option<&str>, now: DateTime<Utc>) -> Duration {
    let Some(header) = header.map(str::trim) else {
        return GAP;
    };
    let asked = if is_decimal(header) {
        header
            .parse::<f64>()
            .ok()
            .and_then(|s| Duration::try_from_secs_f64(s).ok())
    } else {
        DateTime::parse_from_rfc2822(header)
            .ok()
            .and_then(|at| (at.with_timezone(&Utc) - now).to_std().ok())
    };
    asked
        .filter(|wait| {
            TimeDelta::from_std(*wait).is_ok_and(|d| now.checked_add_signed(d).is_some())
        })
        .map_or(GAP, |wait| wait.max(GAP))
}

/// Digits, with a fraction after one dot if any: `12`, `1.5`.
fn is_decimal(text: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    match text.split_once('.') {
        Some((whole, fraction)) => digits(whole) && digits(fraction),
        None => digits(text),
    }
}

fn after(now: DateTime<Utc>, wait: Duration) -> DateTime<Utc> {
    TimeDelta::from_std(wait)
        .ok()
        .and_then(|d| now.checked_add_signed(d))
        .unwrap_or(DateTime::<Utc>::MAX_UTC)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use corten::axum::{
        Router,
        http::{HeaderMap as Headers, StatusCode},
        response::{IntoResponse, Response},
    };

    use super::*;

    const PATH: &str = "/sh/research/api/search";

    /// A release: how the request went, and when the provider may be asked again.
    type Released = (Status, DateTime<Utc>);

    #[derive(Clone, Default)]
    struct TestGate {
        claims: Arc<AtomicUsize>,
        releases: Arc<Mutex<Vec<Released>>>,
        release_fails: bool,
    }

    impl Gate for TestGate {
        async fn claim(&self, _: Provider) -> Result<Lease, Status> {
            self.claims.fetch_add(1, Ordering::SeqCst);
            Ok(Lease {
                id: "lease".into(),
                revision: 1,
                secret: "private=value".into(),
                user_agent: "test-agent".into(),
            })
        }

        async fn release(
            &self,
            _: Provider,
            _: &Lease,
            status: Status,
            retry_at: DateTime<Utc>,
        ) -> Result<(), Status> {
            self.releases.lock().unwrap().push((status, retry_at));
            if self.release_fails {
                Err(Status::Unavailable)
            } else {
                Ok(())
            }
        }
    }

    impl TestGate {
        fn released(&self) -> Vec<Status> {
            self.releases
                .lock()
                .unwrap()
                .iter()
                .map(|(status, _)| *status)
                .collect()
        }
    }

    /// A provider on this machine that answers every request with `answer`, counting them; both
    /// providers' origins point at it.
    async fn provider<F>(answer: F) -> (Transport, Arc<AtomicUsize>)
    where
        F: Fn(Headers) -> Response + Clone + Send + Sync + 'static,
    {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let app = Router::new().fallback(move |headers: Headers| {
            counted.fetch_add(1, Ordering::SeqCst);
            let answer = answer.clone();
            async move { answer(headers) }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { corten::axum::serve(listener, app).await });
        (Transport::to(&origin, &origin), calls)
    }

    fn never() -> std::future::Pending<()> {
        std::future::pending()
    }

    async fn ask(
        transport: &Transport,
        gate: &TestGate,
        provider: Provider,
        path: &str,
    ) -> Result<String, Status> {
        transport
            .request(gate, provider, Ask::get(path), |_| Ok(()), never())
            .await
    }

    #[tokio::test]
    async fn each_provider_gets_its_own_credential_header() {
        let (transport, _) = provider(|h: Headers| {
            let has = |name: &str| h.get(name).map(|v| v.to_str().unwrap().to_owned());
            match (has("authorization"), has("cookie")) {
                (Some(auth), None) if auth == "Bearer private=value" => "{}".into_response(),
                (None, Some(cookie))
                    if cookie == "private=value"
                        && has("user-agent").as_deref() == Some("test-agent") =>
                {
                    "{}".into_response()
                }
                _ => StatusCode::BAD_REQUEST.into_response(),
            }
        })
        .await;
        let gate = TestGate::default();
        assert_eq!(
            ask(&transport, &gate, Provider::Alt, "/graphql/Me").await,
            Ok("{}".into())
        );
        assert_eq!(
            ask(&transport, &gate, Provider::EbayResearch, PATH).await,
            Ok("{}".into())
        );
        assert_eq!(gate.released(), [Status::Connected, Status::Connected]);
    }

    #[tokio::test]
    async fn a_redirect_or_refusal_asks_to_reconnect_without_following() {
        for code in [
            StatusCode::FOUND,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
        ] {
            let (transport, calls) = provider(move |_| {
                (code, [("location", "https://attacker.example/")]).into_response()
            })
            .await;
            let gate = TestGate::default();
            assert_eq!(
                ask(&transport, &gate, Provider::EbayResearch, PATH).await,
                Err(Status::ReconnectRequired)
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(gate.released(), [Status::ReconnectRequired]);
        }
    }

    #[tokio::test]
    async fn a_sign_in_page_asks_to_reconnect() {
        let (transport, _) = provider(|_| "  <html>Sign in</html>".into_response()).await;
        let gate = TestGate::default();
        assert_eq!(
            ask(&transport, &gate, Provider::EbayResearch, PATH).await,
            Err(Status::ReconnectRequired)
        );
    }

    #[tokio::test]
    async fn a_body_past_two_megabytes_is_refused_and_cools_down() {
        let (transport, _) = provider(|_| "x".repeat(MAX_BODY + 1).into_response()).await;
        let gate = TestGate::default();
        let start = Utc::now();
        assert_eq!(
            ask(&transport, &gate, Provider::EbayResearch, PATH).await,
            Err(Status::InvalidResponse)
        );
        let (_, retry_at) = gate.releases.lock().unwrap()[0];
        assert!(retry_at >= start + TimeDelta::seconds(30));
    }

    #[tokio::test]
    async fn a_wait_longer_than_the_deadline_is_kept_and_not_waited_for() {
        let (transport, calls) = provider(|_| {
            (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "3600")]).into_response()
        })
        .await;
        let gate = TestGate::default();
        let start = Utc::now();
        assert_eq!(
            ask(&transport, &gate, Provider::EbayResearch, PATH).await,
            Err(Status::RateLimited)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (_, retry_at) = gate.releases.lock().unwrap()[0];
        assert!(retry_at >= start + TimeDelta::seconds(3600));
    }

    #[test]
    fn retry_after_reads_seconds_or_a_date() {
        let now = DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(retry_after(Some("garbage"), now), GAP);
        assert_eq!(retry_after(None, now), GAP);
        assert_eq!(retry_after(Some("1"), now), GAP);
        assert_eq!(retry_after(Some("90"), now), Duration::from_secs(90));
        assert_eq!(
            retry_after(Some("Wed, 01 Jan 2025 00:01:00 GMT"), now),
            Duration::from_secs(60)
        );
        assert_eq!(retry_after(Some("Tue, 31 Dec 2024 00:00:00 GMT"), now), GAP);
    }

    #[tokio::test]
    async fn a_path_off_the_allowed_list_never_claims_or_calls() {
        let (transport, calls) = provider(|_| "{}".into_response()).await;
        let gate = TestGate::default();
        for path in [
            "//attacker.example/sh/research/api/search",
            "https://attacker.example/",
            "/signin",
            "/\\attacker.example/",
        ] {
            assert_eq!(
                ask(&transport, &gate, Provider::EbayResearch, path).await,
                Err(Status::InvalidResponse)
            );
        }
        let zero = Ask {
            timeout: Duration::ZERO,
            ..Ask::get(PATH)
        };
        assert_eq!(
            transport
                .request(&gate, Provider::EbayResearch, zero, |_| Ok(()), never())
                .await,
            Err(Status::InvalidResponse)
        );
        let cancelled = transport
            .request(
                &gate,
                Provider::EbayResearch,
                Ask::get(PATH),
                |_| Ok(()),
                async {},
            )
            .await;
        assert_eq!(cancelled, Err(Status::Cancelled));
        assert_eq!(gate.claims.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_cancelled_request_releases_its_lease_as_cancelled() {
        // A provider that takes the connection and never answers.
        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", silent.local_addr().unwrap());
        let transport = Transport::to(&origin, &origin);
        let gate = TestGate::default();
        let cancel = sleep(Duration::from_millis(50));
        let answered = transport
            .request(
                &gate,
                Provider::EbayResearch,
                Ask::get(PATH),
                |_| Ok(()),
                cancel,
            )
            .await;
        assert_eq!(answered, Err(Status::Cancelled));
        assert_eq!(gate.released(), [Status::Cancelled]);
    }

    #[tokio::test]
    async fn a_lease_that_cannot_be_released_is_unavailable() {
        let (transport, _) = provider(|_| "{}".into_response()).await;
        let gate = TestGate {
            release_fails: true,
            ..TestGate::default()
        };
        assert_eq!(
            ask(&transport, &gate, Provider::EbayResearch, PATH).await,
            Err(Status::Unavailable)
        );
    }
}
