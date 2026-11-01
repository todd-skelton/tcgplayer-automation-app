//! The JSON routes ported from the Node app, and what they share: its query reading and its
//! error shape, `{"error": message}` with the status, which its callers read.
//!
//! They are added to the app's one API at `/api`, beside the relay to the Node app for the rest:
//! Corten refuses an API inside another's prefix, so a feature cannot own one at its own path.
use corten::{Api, JsonResponse, Prefix, axum::http::StatusCode, json::Raw, prelude::*};
use serde::Serialize;
use serde_json::json;

use crate::{
    app::Shared,
    features::{
        forecast_calibration, inventory_economics::ledger::fingerprint::js_json, inventory_fifo,
        inventory_history, seller_order_history, shipping_thresholds,
    },
};

/// Every ported route, each from its feature.
pub fn ported<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    let api = forecast_calibration::json_route::routes(api, shared);
    let api = inventory_fifo::json_route::routes(api, shared);
    let api = inventory_history::json_route::routes(api, shared);
    let api = seller_order_history::json_route::routes(api, shared);
    shipping_thresholds::json_route::routes(api, shared)
}

/// `value` as the Node route wrote it, with `JSON.stringify`'s numbers: a whole `f64` is `2`,
/// where Corten's `Json` writes `2.0` as serde_json does.
pub fn node_json(value: &impl Serialize) -> JsonResponse {
    Json(Raw::new(js_json(value)).expect("serde_json writes one JSON value")).into()
}

/// Node's error answer: `data({ error }, { status })`.
pub fn error(status: StatusCode, message: impl std::fmt::Display) -> JsonResponse {
    Json(json!({ "error": message.to_string() })).with_status(status)
}

/// `new URL(request.url).searchParams.get(name)`: the first value sent for `name`.
pub fn first(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// JavaScript's `Number(text)`: blank is 0, surrounding white space is ignored, `0x`, `0o` and
/// `0b` read in their base, and anything else that is not a decimal number is `None` (NaN).
pub fn js_number(text: &str) -> Option<f64> {
    let t = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = t
            .strip_prefix(prefix)
            .or_else(|| t.strip_prefix(&prefix.to_uppercase()))
        {
            return u128::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return Some(if t.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            });
        }
        // Rust also reads `inf`, `nan` and `infinity` in any case, which JavaScript does not.
        rest if rest
            .chars()
            .any(|c| c.is_ascii_alphabetic() && !matches!(c, 'e' | 'E')) =>
        {
            return None;
        }
        _ => {}
    }
    t.parse().ok()
}

#[cfg(test)]
pub mod tests {
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        app::{Shared, app},
        database::Database,
        features::slab_connections,
        legacy::Legacy,
    };

    /// Each request Node's route was asked (`.port-logs/api-node.ts <name>`, recorded in
    /// `.port-logs/api/<name>.node.json` as `{path, post?, status, body}`, `post` the JSON a post
    /// sent) gets the status and JSON it gave, through the app's router, on the dev database. `timed` are JSON pointers to what
    /// says when it was read, which differ by when each ran. Numbers are compared as written, since
    /// serde_json reads `2` and `2.0` as different values.
    pub async fn answers_as_node(name: &str, timed: &[&str]) {
        crate::config::load_env();
        let recorded = std::fs::read_to_string(format!(".port-logs/api/{name}.node.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&recorded).unwrap();
        let router = app(Shared {
            db: Database::connect_lazy(&crate::config::database_url()),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .router();
        let untimed = |mut body: Value| {
            for pointer in timed {
                if let Some(at) = body.pointer_mut(pointer) {
                    *at = Value::Null;
                }
            }
            body
        };
        assert!(!node.is_empty(), "{name}: nothing recorded");
        for expected in &node {
            let path = expected["path"].as_str().unwrap();
            let asked = format!("{path} {}", expected["post"]);
            // A post was sent to the action as JSON; anything else is a `GET`.
            let request = match expected["post"].as_str() {
                Some(body) => corten::axum::http::Request::post(path)
                    .header("content-type", "application/json")
                    .body(corten::axum::body::Body::from(body.to_owned())),
                None => {
                    corten::axum::http::Request::get(path).body(corten::axum::body::Body::empty())
                }
            }
            .unwrap();
            let answer = router.clone().oneshot(request).await.unwrap();
            let status = answer.status().as_u16();
            let kind = answer.headers()["content-type"]
                .to_str()
                .unwrap()
                .to_owned();
            let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert!(kind.starts_with("application/json"), "{asked}: {kind}");
            assert_eq!(
                u64::from(status),
                expected["status"].as_u64().unwrap(),
                "{asked}"
            );
            assert_eq!(untimed(body), untimed(expected["body"].clone()), "{asked}");
        }
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        for (text, number) in [
            ("", Some(0.0)),
            ("  ", Some(0.0)),
            (" 28 ", Some(28.0)),
            ("28.0", Some(28.0)),
            ("2.8e1", Some(28.0)),
            ("0x1c", Some(28.0)),
            ("0b11100", Some(28.0)),
            ("+28", Some(28.0)),
            ("-Infinity", Some(f64::NEG_INFINITY)),
            ("28d", None),
            ("inf", None),
            ("NaN", None),
            ("0x", None),
            ("1_000", None),
        ] {
            assert_eq!(js_number(text), number, "{text:?}");
        }
    }

    #[test]
    fn the_first_value_sent_is_the_one_read() {
        assert_eq!(
            first(Some("days=28&days=56"), "days").as_deref(),
            Some("28")
        );
        assert_eq!(first(Some("a=1&da%79s=+5"), "days").as_deref(), Some(" 5"));
        assert_eq!(first(Some("a=1"), "days"), None);
        assert_eq!(first(None, "days"), None);
    }
}
