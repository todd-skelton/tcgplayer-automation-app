//! EasyPost's API (`api.easypost.com/v2`), as the Node app's `@easypost/api` client calls it: the
//! mode's API key as the basic auth user, JSON both ways, and a failure read from the answer's
//! `error`.
use std::time::Duration;

use serde_json::Value;

use crate::features::shipping_configuration::EasyPostMode;

const ORIGIN: &str = "https://api.easypost.com";
/// The client's default, as the Node client's.
const TIMEOUT: Duration = Duration::from_secs(60);

/// A shipment's public tracking page, by EasyPost's shipment id.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait TrackingPages {
    async fn tracking_url(&self, mode: EasyPostMode, shipment_id: &str) -> Result<String, String>;
}

/// EasyPost, at its origin or a stand-in's.
pub struct EasyPost {
    http: reqwest::Client,
    origin: String,
    /// A key for every mode, in a test; otherwise each mode's from the environment.
    key: Option<String>,
}

impl Default for EasyPost {
    fn default() -> Self {
        EasyPost::at(ORIGIN)
    }
}

impl EasyPost {
    fn at(origin: &str) -> Self {
        EasyPost {
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .expect("the HTTP client builds"),
            origin: origin.trim_end_matches('/').to_owned(),
            key: None,
        }
    }

    /// A stand-in at `origin` that every mode reaches with `key`.
    #[cfg(test)]
    pub(crate) fn stand_in(origin: &str, key: &str) -> Self {
        EasyPost {
            key: Some(key.to_owned()),
            ..EasyPost::at(origin)
        }
    }

    /// The mode's API key (`getEasyPostApiKey`).
    fn key(&self, mode: EasyPostMode) -> Result<String, String> {
        if let Some(key) = &self.key {
            return Ok(key.clone());
        }
        std::env::var(mode.key_name())
            .ok()
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                format!(
                    "Missing {} for EasyPost {} mode.",
                    mode.key_name(),
                    mode.name()
                )
            })
    }

    /// GETs `path` under `/v2/` in `mode`, answering the JSON or why not as the Node client
    /// words it (the answer's error message).
    pub async fn get(&self, mode: EasyPostMode, path: &str) -> Result<Value, String> {
        let key = self.key(mode)?;
        let answer = self
            .http
            .get(format!("{}/v2/{path}", self.origin))
            .basic_auth(key, None::<&str>)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            // The transport's error can hold the URL, never the key.
            .map_err(|e| e.without_url().to_string())?;
        let status = answer.status();
        let bytes = answer
            .bytes()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if status.is_success() {
            Ok(body)
        } else {
            Err(failure(&body))
        }
    }
}

/// The message of an EasyPost error answer, its parts joined as the Node client joins them.
fn failure(body: &Value) -> String {
    fn texts(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => map.values().for_each(|v| texts(v, out)),
            Value::Array(items) => items.iter().for_each(|v| texts(v, out)),
            Value::String(s) => out.push(s.clone()),
            Value::Null => out.push("null".to_owned()),
            other => out.push(other.to_string()),
        }
    }
    let mut out = Vec::new();
    texts(&body["error"]["message"], &mut out);
    out.join(", ")
}

impl TrackingPages for EasyPost {
    /// `getPublicTrackingUrlForPurchasedShipment`.
    async fn tracking_url(&self, mode: EasyPostMode, shipment_id: &str) -> Result<String, String> {
        let shipment = self.get(mode, &format!("shipments/{shipment_id}")).await?;
        shipment["tracker"]["public_url"]
            .as_str()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                format!("EasyPost shipment {shipment_id} does not have a public tracking URL.")
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_reads_as_the_node_client_reads_it() {
        let body = serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "The requested resource could not be found." } });
        assert_eq!(failure(&body), "The requested resource could not be found.");
        let nested =
            serde_json::json!({ "error": { "message": { "a": ["one", "two"], "b": "three" } } });
        assert_eq!(failure(&nested), "one, two, three");
    }
}
