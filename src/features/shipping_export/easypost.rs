//! EasyPost's API (`api.easypost.com/v2`), as the Node app's `@easypost/api` client calls it: the
//! mode's API key as the basic auth user, JSON both ways, and a failure read from the answer's
//! `error`.
use std::time::Duration;

use serde_json::Value;

use crate::features::shipping_configuration::EasyPostMode;

const ORIGIN: &str = "https://api.easypost.com";
/// The client's default, as the Node client's.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Why EasyPost gave no answer: what its error said, or the transport's failure.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Failure {
    pub code: Option<String>,
    pub status: Option<u16>,
    pub message: String,
    /// Each field's error: its field, when named, and its message.
    pub errors: Vec<(Option<String>, Option<String>)>,
}

impl Failure {
    fn plain(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
            ..Failure::default()
        }
    }

    /// The failure read from an error answer (`handleApiError`): its message's texts joined.
    fn of_answer(status: u16, body: &Value) -> Self {
        fn texts(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Object(map) => map.values().for_each(|v| texts(v, out)),
                Value::Array(items) => items.iter().for_each(|v| texts(v, out)),
                Value::String(s) => out.push(s.clone()),
                Value::Null => {}
                other => out.push(other.to_string()),
            }
        }
        let error = &body["error"];
        let mut message = Vec::new();
        texts(&error["message"], &mut message);
        Failure {
            code: error["code"].as_str().map(str::to_owned),
            status: Some(status),
            message: message.join(", "),
            errors: error["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| {
                    let text = |key: &str| e[key].as_str().map(str::to_owned);
                    (text("field"), text("message"))
                })
                .collect(),
        }
    }

    /// As the Node app writes it on a purchase (`formatEasyPostError`).
    pub fn formatted(&self) -> String {
        let nested: Vec<String> = self
            .errors
            .iter()
            .map(|(field, message)| {
                let prefix = field.as_ref().map_or(String::new(), |f| format!("{f}: "));
                let message = message.as_deref().unwrap_or("Unknown field error");
                format!("{prefix}{message}")
            })
            .collect();
        let nested = nested.join("; ");
        [
            self.code
                .as_ref()
                .filter(|c| !c.is_empty())
                .map(|c| format!("code={c}")),
            self.status
                .filter(|s| *s != 0)
                .map(|s| format!("status={s}")),
            Some(self.message.clone()).filter(|m| !m.is_empty()),
            Some(nested).filter(|n| !n.is_empty()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" | ")
    }
}

/// EasyPost's API in a mode.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Api {
    async fn get(&self, mode: EasyPostMode, path: &str) -> Result<Value, Failure>;
    async fn post(&self, mode: EasyPostMode, path: &str, body: &Value) -> Result<Value, Failure>;
}

/// EasyPost, at its origin or a stand-in's.
pub struct EasyPost {
    http: reqwest::Client,
    origin: String,
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
        }
    }

    /// The mode's API key (`getEasyPostApiKey`).
    fn key(&self, mode: EasyPostMode) -> Result<String, Failure> {
        std::env::var(mode.key_name())
            .ok()
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                Failure::plain(format!(
                    "Missing {} for EasyPost {} mode.",
                    mode.key_name(),
                    mode.name()
                ))
            })
    }

    async fn send(
        &self,
        mode: EasyPostMode,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Failure> {
        let key = self.key(mode)?;
        let mut request = self
            .http
            .request(method, format!("{}/v2/{path}", self.origin))
            .basic_auth(key, None::<&str>)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }
        // The transport's error can hold the URL, never the key.
        let failed = |e: reqwest::Error| Failure::plain(e.without_url().to_string());
        let answer = request.send().await.map_err(failed)?;
        let status = answer.status();
        let bytes = answer.bytes().await.map_err(failed)?;
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|e| Failure::plain(e.to_string()))?;
        if status.is_success() {
            Ok(body)
        } else {
            Err(Failure::of_answer(status.as_u16(), &body))
        }
    }
}

impl Api for EasyPost {
    async fn get(&self, mode: EasyPostMode, path: &str) -> Result<Value, Failure> {
        self.send(mode, reqwest::Method::GET, path, None).await
    }

    async fn post(&self, mode: EasyPostMode, path: &str, body: &Value) -> Result<Value, Failure> {
        self.send(mode, reqwest::Method::POST, path, Some(body))
            .await
    }
}

/// A purchased shipment's public tracking page (`getPublicTrackingUrlForPurchasedShipment`),
/// or why not.
pub async fn tracking_url(
    api: &impl Api,
    mode: EasyPostMode,
    shipment_id: &str,
) -> Result<String, String> {
    let shipment = api
        .get(mode, &format!("shipments/{shipment_id}"))
        .await
        .map_err(|e| e.message)?;
    shipment["tracker"]["public_url"]
        .as_str()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            format!("EasyPost shipment {shipment_id} does not have a public tracking URL.")
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_failure_reads_as_the_node_client_reads_it() {
        let body = json!({ "error": { "code": "NOT_FOUND", "message": "The requested resource could not be found." } });
        let failure = Failure::of_answer(404, &body);
        assert_eq!(
            failure.formatted(),
            "code=NOT_FOUND | status=404 | The requested resource could not be found."
        );
        let nested = json!({ "error": { "code": "BAD", "message": { "a": ["one", "two"], "b": "three" },
            "errors": [{ "field": "to_address.zip", "message": "is invalid" }, { "message": null }] } });
        assert_eq!(
            Failure::of_answer(422, &nested).formatted(),
            "code=BAD | status=422 | one, two, three | to_address.zip: is invalid; Unknown field error"
        );
    }
}
