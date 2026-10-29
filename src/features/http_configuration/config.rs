//! The HTTP client's settings (`http_config`, one row keyed `default`): TCGplayer's auth cookie,
//! the user agent, each API domain's rate limits and the adaptive algorithm's tuning. The Node
//! workers read the same row, so the JSON columns keep the React app's camelCase shape.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::database::Database;

const CONFIG_KEY: &str = "default";

/// A TCGplayer API host, each with its own rate limiter, named as `domain_configs` stores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, corten::UrlValue)]
#[serde(rename_all = "camelCase")]
pub enum Domain {
    MpSearchApi,
    MpApi,
    InfiniteApi,
    MpGateway,
    OrderManagementApi,
    MessagesApi,
    SellerPortal,
}

impl Domain {
    /// In the order the screen lists them.
    pub const ALL: [Domain; 7] = [
        Domain::MpSearchApi,
        Domain::MpApi,
        Domain::InfiniteApi,
        Domain::MpGateway,
        Domain::OrderManagementApi,
        Domain::MessagesApi,
        Domain::SellerPortal,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Domain::MpSearchApi => "Search API (mp-search-api)",
            Domain::MpApi => "Marketplace API (mpapi)",
            Domain::InfiniteApi => "Infinite API (infinite-api)",
            Domain::MpGateway => "Gateway API (mpgateway)",
            Domain::OrderManagementApi => "Order Management API",
            Domain::MessagesApi => "Messages API",
            Domain::SellerPortal => "Seller Portal (store)",
        }
    }

    /// The domain's key in `domain_configs`, as serde writes it.
    pub fn key(self) -> String {
        match serde_json::to_value(self) {
            Ok(Value::String(key)) => key,
            _ => unreachable!("a unit variant serializes as its name"),
        }
    }

    /// The domain's settings before anyone changes them. The seller portal is a website, so it
    /// goes one request at a time, two seconds apart.
    pub fn default_limits(self) -> Limits {
        match self {
            Domain::SellerPortal => Limits {
                request_delay_ms: 2000,
                rate_limit_cooldown_ms: 10000,
                max_concurrent_requests: 1,
                adaptive_enabled: false,
                min_request_delay_ms: 2000,
                max_request_delay_ms: 10000,
                learned_min_delay_ms: 0,
            },
            _ => Limits {
                request_delay_ms: 0,
                rate_limit_cooldown_ms: 10000,
                max_concurrent_requests: 5,
                adaptive_enabled: true,
                min_request_delay_ms: 0,
                max_request_delay_ms: 10000,
                learned_min_delay_ms: 0,
            },
        }
    }
}

/// One domain's rate limits.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub request_delay_ms: u32,
    pub rate_limit_cooldown_ms: u32,
    pub max_concurrent_requests: u32,
    /// Adaptive (AIMD) delays: raised on a rate limit, lowered after a run of successes.
    pub adaptive_enabled: bool,
    pub min_request_delay_ms: u32,
    pub max_request_delay_ms: u32,
    /// The floor the workers learned, which ratchets up on each rate limit.
    pub learned_min_delay_ms: u32,
}

/// How adaptive domains move their delay.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adaptive {
    pub increase_multiplier: f64,
    pub floor_step_ms: u32,
    pub decrease_amount_ms: u32,
    pub success_threshold: u32,
}

impl Default for Adaptive {
    fn default() -> Self {
        Adaptive {
            increase_multiplier: 2.0,
            floor_step_ms: 100,
            decrease_amount_ms: 100,
            success_threshold: 10,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HttpConfig {
    pub tcg_auth_cookie: String,
    pub user_agent: String,
    /// In [`Domain::ALL`]'s order.
    pub domains: [(Domain, Limits); 7],
    pub adaptive: Adaptive,
}

impl Default for HttpConfig {
    fn default() -> Self {
        HttpConfig {
            tcg_auth_cookie: String::new(),
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36".into(),
            domains: Domain::ALL.map(|d| (d, d.default_limits())),
            adaptive: Adaptive::default(),
        }
    }
}

#[cfg(test)]
impl HttpConfig {
    pub fn limits(&self, domain: Domain) -> Limits {
        self.domains
            .iter()
            .find(|(d, _)| *d == domain)
            .map_or(domain.default_limits(), |(_, l)| *l)
    }
}

/// `stored`'s keys over `defaults`', one level deep: what the React app's object spread gives.
fn over(defaults: Value, stored: Option<&Value>) -> Value {
    match (defaults, stored) {
        (Value::Object(mut base), Some(Value::Object(top))) => {
            base.extend(top.iter().map(|(k, v)| (k.clone(), v.clone())));
            Value::Object(base)
        }
        (defaults, _) => defaults,
    }
}

/// The settings as stored, each domain and the adaptive tuning filled in from the defaults
/// where the row predates them; the defaults when there is no row or it does not read.
fn from_row(cookie: String, user_agent: String, domains: &Value, adaptive: &Value) -> HttpConfig {
    let domains = Domain::ALL.map(|d| {
        let defaults = serde_json::to_value(d.default_limits()).expect("limits serialize");
        let merged = over(defaults, domains.get(d.key()));
        (
            d,
            serde_json::from_value(merged).unwrap_or(d.default_limits()),
        )
    });
    let defaults = serde_json::to_value(Adaptive::default()).expect("adaptive serializes");
    let adaptive = serde_json::from_value(over(defaults, Some(adaptive))).unwrap_or_default();
    HttpConfig {
        tcg_auth_cookie: cookie,
        user_agent,
        domains,
        adaptive,
    }
}

pub async fn load(db: &Database) -> sqlx::Result<HttpConfig> {
    let row: Option<(String, String, Value, Value)> = sqlx::query_as(
        "SELECT tcg_auth_cookie, user_agent, domain_configs, adaptive_config FROM http_config WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .fetch_optional(&db.0)
    .await?;
    Ok(
        row.map_or_else(HttpConfig::default, |(cookie, agent, domains, adaptive)| {
            from_row(cookie, agent, &domains, &adaptive)
        }),
    )
}

pub async fn save(db: &Database, config: &HttpConfig) -> sqlx::Result<()> {
    let domains: Map<String, Value> = config
        .domains
        .iter()
        .map(|(d, limits)| {
            (
                d.key(),
                serde_json::to_value(limits).expect("limits serialize"),
            )
        })
        .collect();
    sqlx::query(
        "INSERT INTO http_config (config_key, tcg_auth_cookie, user_agent, domain_configs, adaptive_config)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (config_key) DO UPDATE SET
           tcg_auth_cookie = EXCLUDED.tcg_auth_cookie,
           user_agent = EXCLUDED.user_agent,
           domain_configs = EXCLUDED.domain_configs,
           adaptive_config = EXCLUDED.adaptive_config",
    )
    .bind(CONFIG_KEY)
    .bind(&config.tcg_auth_cookie)
    .bind(&config.user_agent)
    .bind(Value::Object(domains))
    .bind(serde_json::to_value(config.adaptive).expect("adaptive serializes"))
    .execute(&db.0)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_stored_domain_keeps_its_values_and_fills_what_it_lacks() {
        let domains = json!({ "mpSearchApi": { "requestDelayMs": 750, "adaptiveEnabled": false } });
        let config = from_row(
            "c".into(),
            "ua".into(),
            &domains,
            &json!({ "floorStepMs": 250 }),
        );
        let search = config.limits(Domain::MpSearchApi);
        assert_eq!(
            (
                search.request_delay_ms,
                search.adaptive_enabled,
                search.max_concurrent_requests
            ),
            (750, false, 5)
        );
        assert_eq!(
            config.limits(Domain::SellerPortal),
            Domain::SellerPortal.default_limits()
        );
        assert_eq!(
            (
                config.adaptive.floor_step_ms,
                config.adaptive.success_threshold
            ),
            (250, 10)
        );
    }

    #[test]
    fn domains_are_stored_under_the_react_apps_keys() {
        assert_eq!(
            serde_json::to_value(Domain::OrderManagementApi).unwrap(),
            json!("orderManagementApi")
        );
        assert_eq!(serde_json::to_value(Domain::MpApi).unwrap(), json!("mpApi"));
        let limits = serde_json::to_value(Domain::MpApi.default_limits()).unwrap();
        assert!(
            limits.get("rateLimitCooldownMs").is_some()
                && limits.get("learnedMinDelayMs").is_some()
        );
    }
}
