//! The JSON routes ported from the Node app, and what they share: its query reading and its
//! error shape, `{"error": message}` with the status, which its callers read.
//!
//! They are added to the app's one API at `/api`, beside the relay to the Node app for the rest:
//! Corten refuses an API inside another's prefix, so a feature cannot own one at its own path.
use corten::{Api, JsonResponse, Prefix, http::StatusCode, json::Raw, prelude::*};
use serde::Serialize;
use serde_json::json;

use crate::{
    app::Shared,
    features::{
        batch_pricer, configuration, forecast_calibration,
        inventory_economics::{
            self,
            ledger::fingerprint::{js_float, js_json},
        },
        inventory_fifo, inventory_history, inventory_intake, inventory_opening_balance,
        publication_configuration, pull_sheet, seller_order_history, shipping_export,
        shipping_thresholds, slab_pricing,
    },
};

/// Every ported route, each from its feature.
pub fn ported<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    let api = batch_pricer::json_route::routes(api, shared);
    let api = configuration::json_route::routes(api, shared);
    let api = forecast_calibration::json_route::routes(api, shared);
    let api = inventory_economics::json_route::routes(api, shared);
    let api = inventory_fifo::json_route::routes(api, shared);
    let api = inventory_history::json_route::routes(api, shared);
    let api = inventory_intake::json_route::routes(api, shared);
    let api = inventory_opening_balance::json_route::routes(api, shared);
    let api = publication_configuration::json_route::routes(api, shared);
    let api = pull_sheet::json_route::routes(api, shared);
    let api = seller_order_history::json_route::routes(api, shared);
    let api = shipping_export::json_route::routes(api, shared);
    let api = slab_pricing::json_route::routes(api, shared);
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

/// JavaScript's `String(value)` of a JSON value.
pub fn js_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_float(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // `join` writes null as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript's `text.trim()`: white space, line ends and the byte order mark, which Rust's
/// `trim` keeps, off both ends.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JavaScript's `Number(text)`: blank is 0, surrounding white space is ignored, `0x`, `0o` and
/// `0b` read in their base, and anything else that is not a decimal number is `None` (NaN).
pub fn js_number(text: &str) -> Option<f64> {
    let t = js_trim(text);
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

/// JavaScript's `Number(value)` of a JSON value: `null` is 0, a boolean 0 or 1, text as
/// [`js_number`] reads it, and a list or object as its `String` is read.
pub fn js_to_number(value: &serde_json::Value) -> f64 {
    use serde_json::Value;
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text).unwrap_or(f64::NAN),
        Value::Array(_) | Value::Object(_) => js_number(&js_string(value)).unwrap_or(f64::NAN),
    }
}

#[cfg(test)]
pub mod tests {
    use corten::{Local, http::Method};
    use serde_json::Value;

    use super::*;
    use crate::{
        app::{Shared, app},
        database::Database,
        features::slab_connections,
        legacy::Legacy,
    };

    /// Each request Node's route was asked (`scripts/parity/record-node-answers.ts <name>`,
    /// recorded in `tests/fixtures/node/api/<name>.json` as
    /// `{path, post?, headers?, status, cacheControl?, body}`, `post` the JSON a post sent with any
    /// `headers` added, from a page at `http://localhost`) gets the status, `Cache-Control` and JSON
    /// it gave, through the app's router, on the dev database. Order numbers are recorded as their
    /// aliases (`crate::parity_fixture`). `timed` are JSON pointers to what says when it was read,
    /// which differ by when each ran. Numbers are compared as written, since serde_json reads `2`
    /// and `2.0` as different values.
    pub async fn answers_as_node(name: &str, timed: &[&str]) {
        crate::config::load_env();
        let node: Vec<Value> = crate::parity_fixture::read(&format!("node/api/{name}.json"));
        let orders = crate::parity_fixture::Orders::of_dev_database().await;
        let client = app(Shared {
            db: Database::connect_lazy(&crate::config::database_url()),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .test();
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
            // A recorded path is what Node was asked, so it is sent as written.
            let at = Local::parse(path).unwrap_or_else(|| panic!("{path} is not a local path"));
            // A post was sent to the action as JSON; anything else is a `GET`.
            let answer = match expected["post"].as_str().map(|body| orders.real(body)) {
                Some(body) => {
                    let mut post = client
                        .call(Method::POST, &at)
                        .header(corten::http::header::HOST, "localhost")
                        .body("application/json", body);
                    for (name, value) in expected["headers"].as_object().into_iter().flatten() {
                        post = post.header(name.parse().unwrap(), value.as_str().unwrap());
                    }
                    post.await
                }
                None => client.get(&at).await,
            };
            let status = answer.status().as_u16();
            let cache = answer.headers().get("cache-control").cloned();
            let kind = answer.headers()["content-type"]
                .to_str()
                .unwrap()
                .to_owned();
            let body =
                crate::parity_fixture::scrub(serde_json::from_slice(answer.bytes()).unwrap());
            assert!(kind.starts_with("application/json"), "{asked}: {kind}");
            assert_eq!(
                u64::from(status),
                expected["status"].as_u64().unwrap(),
                "{asked}"
            );
            assert_eq!(untimed(body), untimed(expected["body"].clone()), "{asked}");
            if let Some(expected) = expected["cacheControl"].as_str() {
                assert_eq!(
                    cache.as_ref().map(|v| v.to_str().unwrap()),
                    Some(expected),
                    "{asked}"
                );
            }
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
}
