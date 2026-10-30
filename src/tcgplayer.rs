//! TCGplayer's APIs, called as the Node app's `DomainHttpClient` calls them: the auth cookie and
//! user agent from `http_config`, and per domain a delay between request starts, a cap on requests
//! in flight, a cooldown after a rate limit and, for adaptive domains, a delay that rises on a rate
//! limit and falls after a run of successes. Ported from `app/core/clients/baseDomainClient.server.ts`.
//!
//! Each app throttles its own requests: while Node and this run side by side, TCGplayer sees both.
//! The delays this client learns stay in this process (`http_config` is Node's until the workers
//! move here), so a shadow run changes nothing the Node workers read.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{Method, header};
use serde::{Serialize, de::DeserializeOwned};
use tokio::{sync::Notify, time::Instant};

use crate::{
    database::Database,
    features::http_configuration::config::{self, Adaptive, Domain, HttpConfig, Limits},
};

/// Attempts after the first, when a request retries.
const MAX_RETRIES: u32 = 3;

/// The host each domain's requests go to (`TCGPLAYER_DOMAINS` in the Node app).
pub fn host(domain: Domain) -> &'static str {
    match domain {
        Domain::MpSearchApi => "mp-search-api.tcgplayer.com",
        Domain::MpApi => "mpapi.tcgplayer.com",
        Domain::InfiniteApi => "infinite-api.tcgplayer.com",
        Domain::MpGateway => "mpgateway.tcgplayer.com",
        Domain::OrderManagementApi => "order-management-api.tcgplayer.com",
        Domain::MessagesApi => "messages-api.tcgplayer.com",
        Domain::SellerPortal => "store.tcgplayer.com",
    }
}

/// How one call is made.
#[derive(Clone, Copy, Debug)]
pub struct Call {
    /// Retry a rate limit or a failing gateway, up to three more times.
    pub retry: bool,
    /// The longest one attempt may take.
    pub timeout: Duration,
}

impl Default for Call {
    fn default() -> Self {
        Call {
            retry: true,
            timeout: Duration::from_secs(60),
        }
    }
}

/// Why a call has no answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    /// TCGplayer answered with this status.
    Status(u16),
    /// No answer: the connection failed or the attempt timed out.
    Unreachable(String),
    /// An answer that is not the JSON expected.
    Unreadable(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Status(status) => write!(f, "Request failed with status code {status}"),
            Failure::Unreachable(why) => write!(f, "TCGplayer could not be reached: {why}"),
            Failure::Unreadable(why) => write!(f, "TCGplayer's answer could not be read: {why}"),
        }
    }
}

impl Failure {
    fn retryable(&self) -> bool {
        matches!(self, Failure::Status(403 | 429 | 502 | 503 | 504))
    }

    fn rate_limit(&self) -> bool {
        matches!(self, Failure::Status(403 | 429))
    }
}

/// The delay and floor after a run of successes, when the delay comes down: by the decrease,
/// never below the larger of the minimum and the learned floor.
pub fn after_successes(limits: &Limits, adaptive: &Adaptive) -> Option<(u32, u32)> {
    if !limits.adaptive_enabled {
        return None;
    }
    let floor = limits.min_request_delay_ms.max(limits.learned_min_delay_ms);
    let delay = floor.max(
        limits
            .request_delay_ms
            .saturating_sub(adaptive.decrease_amount_ms),
    );
    (delay < limits.request_delay_ms).then_some((delay, limits.learned_min_delay_ms))
}

/// The delay and floor after a rate limit: the floor rises a step above the current delay and the
/// delay is that floor times the multiplier, both capped at the maximum.
pub fn after_rate_limit(limits: &Limits, adaptive: &Adaptive) -> Option<(u32, u32)> {
    if !limits.adaptive_enabled {
        return None;
    }
    let floor = limits.max_request_delay_ms.min(
        limits
            .request_delay_ms
            .saturating_add(adaptive.floor_step_ms),
    );
    // Node multiplies in floating point; a whole multiplier (the default 2.0) gives the same
    // whole number, and a fractional one is rounded where Node would store the fraction.
    let raised = (f64::from(floor) * adaptive.increase_multiplier).round();
    let delay = f64::from(limits.max_request_delay_ms).min(raised) as u32;
    Some((delay, floor))
}

/// One domain's throttle: when the last request started, a rate limit's cooldown, the successes
/// since the delay last moved, and the requests in flight.
#[derive(Default)]
struct Lane {
    state: Mutex<LaneState>,
    /// Held while a request waits out the delay since the one before it, so starts are staggered.
    start: tokio::sync::Mutex<Option<Instant>>,
    freed: Notify,
}

#[derive(Default)]
struct LaneState {
    rate_limited_until: Option<Instant>,
    successes: u32,
    in_flight: u32,
    /// The delay and floor this process learned, over the saved ones.
    learned: Option<(u32, u32)>,
}

/// A request in flight, which frees its place when it ends.
struct InFlight<'a>(&'a Lane);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.state.lock().expect("lane lock").in_flight -= 1;
        self.0.freed.notify_one();
    }
}

impl Lane {
    async fn enter(&self, max: u32) -> InFlight<'_> {
        loop {
            let freed = self.freed.notified();
            {
                let mut state = self.state.lock().expect("lane lock");
                if state.in_flight < max.max(1) {
                    state.in_flight += 1;
                    return InFlight(self);
                }
            }
            freed.await;
        }
    }

    async fn wait_to_start(&self, delay: Duration) {
        let cooldown = self.state.lock().expect("lane lock").rate_limited_until;
        if let Some(until) = cooldown {
            tokio::time::sleep_until(until).await;
        }
        let mut last = self.start.lock().await;
        if let Some(last) = *last {
            tokio::time::sleep_until(last + delay).await;
        }
        *last = Some(Instant::now());
    }
}

/// The TCGplayer client. Cloning it shares the throttles.
#[derive(Clone)]
pub struct TcgPlayer {
    http: reqwest::Client,
    db: Database,
    lanes: Arc<[Lane; 7]>,
}

impl TcgPlayer {
    pub fn new(db: Database) -> Self {
        let http = reqwest::Client::builder()
            .build()
            .expect("the TLS backend initializes");
        TcgPlayer {
            http,
            db,
            lanes: Arc::new(Default::default()),
        }
    }

    fn lane(&self, domain: Domain) -> &Lane {
        let at = Domain::ALL
            .iter()
            .position(|d| *d == domain)
            .expect("every domain is listed");
        &self.lanes[at]
    }

    /// The settings now, with the delays this process learned.
    async fn settings(&self, domain: Domain) -> Result<(HttpConfig, Limits), Failure> {
        let config = config::load(&self.db)
            .await
            .map_err(|e| Failure::Unreachable(format!("the HTTP settings did not load: {e}")))?;
        let mut limits = config
            .domains
            .iter()
            .find(|(d, _)| *d == domain)
            .map_or(domain.default_limits(), |(_, l)| *l);
        if let Some((delay, floor)) = self.lane(domain).state.lock().expect("lane lock").learned {
            limits.request_delay_ms = delay;
            limits.learned_min_delay_ms = floor;
        }
        Ok((config, limits))
    }

    fn learn(&self, domain: Domain, delays: (u32, u32)) {
        self.lane(domain).state.lock().expect("lane lock").learned = Some(delays);
    }

    async fn succeeded(&self, domain: Domain, adaptive: &Adaptive) {
        let lane = self.lane(domain);
        let due = {
            let mut state = lane.state.lock().expect("lane lock");
            state.successes += 1;
            let due = state.successes >= adaptive.success_threshold;
            if due {
                state.successes = 0;
            }
            due
        };
        if !due {
            return;
        }
        if let Ok((_, limits)) = self.settings(domain).await
            && let Some(next) = after_successes(&limits, adaptive)
        {
            self.learn(domain, next);
        }
    }

    /// GET `path` on `domain`, read as JSON.
    pub async fn get<T: DeserializeOwned>(
        &self,
        domain: Domain,
        path: &str,
        call: Call,
    ) -> Result<T, Failure> {
        self.send(domain, Method::GET, path, None::<&()>, call)
            .await
    }

    /// POST `body` as JSON to `path` on `domain`, the answer read as JSON.
    pub async fn post<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        domain: Domain,
        path: &str,
        body: &B,
        call: Call,
    ) -> Result<T, Failure> {
        self.send(domain, Method::POST, path, Some(body), call)
            .await
    }

    async fn send<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        domain: Domain,
        method: Method,
        path: &str,
        body: Option<&B>,
        call: Call,
    ) -> Result<T, Failure> {
        let retries = if call.retry { MAX_RETRIES } else { 0 };
        let url = format!("https://{}{path}", host(domain));
        let lane = self.lane(domain);
        let mut rate_limit_learned = false;
        let mut attempt = 0;
        loop {
            let (config, limits) = self.settings(domain).await?;
            let failure = {
                let _in_flight = lane.enter(limits.max_concurrent_requests).await;
                lane.wait_to_start(Duration::from_millis(limits.request_delay_ms.into()))
                    .await;
                match self
                    .attempt(&config, &method, &url, body, call.timeout)
                    .await
                {
                    Ok(answer) => {
                        self.succeeded(domain, &config.adaptive).await;
                        return Ok(answer);
                    }
                    Err(failure) => failure,
                }
            };
            if !failure.retryable() || attempt >= retries {
                return Err(failure);
            }
            if failure.rate_limit() {
                let mut limits = limits;
                if !rate_limit_learned {
                    lane.state.lock().expect("lane lock").successes = 0;
                    if let Some(next) = after_rate_limit(&limits, &config.adaptive) {
                        self.learn(domain, next);
                        (limits.request_delay_ms, limits.learned_min_delay_ms) = next;
                    }
                    rate_limit_learned = true;
                }
                let cooldown = Duration::from_millis(limits.rate_limit_cooldown_ms.into());
                lane.state.lock().expect("lane lock").rate_limited_until =
                    Some(Instant::now() + cooldown);
                tokio::time::sleep(cooldown).await;
            } else {
                tokio::time::sleep(backoff(attempt, limits.request_delay_ms)).await;
            }
            attempt += 1;
        }
    }

    async fn attempt<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        config: &HttpConfig,
        method: &Method,
        url: &str,
        body: Option<&B>,
        timeout: Duration,
    ) -> Result<T, Failure> {
        let mut request = self
            .http
            .request(method.clone(), url)
            .timeout(timeout)
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::USER_AGENT, &config.user_agent);
        if !config.tcg_auth_cookie.is_empty() {
            request = request.header(
                header::COOKIE,
                format!("TCGAuthTicket_Production={};", config.tcg_auth_cookie),
            );
        }
        if let Some(body) = body {
            let body = serde_json::to_vec(body).map_err(|e| Failure::Unreadable(e.to_string()))?;
            request = request.body(body);
        }
        let answer = request
            .send()
            .await
            .map_err(|e| Failure::Unreachable(e.without_url().to_string()))?;
        let status = answer.status();
        if !status.is_success() {
            return Err(Failure::Status(status.as_u16()));
        }
        let bytes = answer
            .bytes()
            .await
            .map_err(|e| Failure::Unreachable(e.without_url().to_string()))?;
        serde_json::from_slice(&bytes).map_err(|e| Failure::Unreadable(e.to_string()))
    }
}

/// The wait before retrying a failing gateway: the delay doubled per attempt, plus up to a
/// second of jitter.
fn backoff(attempt: u32, delay_ms: u32) -> Duration {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos() % 1000);
    Duration::from_millis(u64::from(delay_ms) * 2u64.pow(attempt) + u64::from(jitter))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adaptive_limits(delay: u32, floor: u32) -> Limits {
        Limits {
            request_delay_ms: delay,
            learned_min_delay_ms: floor,
            ..Domain::OrderManagementApi.default_limits()
        }
    }

    #[test]
    fn a_rate_limit_from_no_delay_steps_then_doubles() {
        let next = after_rate_limit(&adaptive_limits(0, 0), &Adaptive::default());
        assert_eq!(next, Some((200, 100)));
        let next = after_rate_limit(&adaptive_limits(200, 100), &Adaptive::default());
        assert_eq!(next, Some((600, 300)));
    }

    #[test]
    fn a_rate_limit_is_capped_at_the_maximum() {
        let next = after_rate_limit(&adaptive_limits(9_950, 0), &Adaptive::default());
        assert_eq!(next, Some((10_000, 10_000)));
    }

    #[test]
    fn successes_lower_the_delay_to_the_learned_floor() {
        let adaptive = Adaptive::default();
        assert_eq!(
            after_successes(&adaptive_limits(600, 300), &adaptive),
            Some((500, 300))
        );
        assert_eq!(
            after_successes(&adaptive_limits(350, 300), &adaptive),
            Some((300, 300))
        );
        assert_eq!(after_successes(&adaptive_limits(300, 300), &adaptive), None);
    }

    #[test]
    fn a_domain_without_adaptive_delays_keeps_them() {
        let limits = Domain::SellerPortal.default_limits();
        assert_eq!(after_rate_limit(&limits, &Adaptive::default()), None);
        assert_eq!(after_successes(&limits, &Adaptive::default()), None);
    }

    #[test]
    fn only_rate_limits_and_failing_gateways_retry() {
        for status in [403, 429, 502, 503, 504] {
            assert!(Failure::Status(status).retryable());
        }
        for failure in [
            Failure::Status(400),
            Failure::Status(401),
            Failure::Status(500),
            Failure::Unreachable("timed out".into()),
        ] {
            assert!(!failure.retryable());
        }
        assert!(Failure::Status(429).rate_limit() && !Failure::Status(502).rate_limit());
    }

    #[tokio::test(start_paused = true)]
    async fn starts_are_staggered_by_the_delay() {
        let lane = Lane::default();
        let begin = Instant::now();
        lane.wait_to_start(Duration::from_millis(500)).await;
        lane.wait_to_start(Duration::from_millis(500)).await;
        lane.wait_to_start(Duration::from_millis(500)).await;
        assert_eq!(begin.elapsed(), Duration::from_millis(1000));
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_lane_waits_for_a_place() {
        let lane = Arc::new(Lane::default());
        let first = lane.enter(1).await;
        let waiting = {
            let lane = lane.clone();
            tokio::spawn(async move {
                let _second = lane.enter(1).await;
                Instant::now()
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let freed_at = Instant::now();
        drop(first);
        assert_eq!(waiting.await.unwrap(), freed_at);
    }
}
