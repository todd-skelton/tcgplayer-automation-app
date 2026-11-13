//! JavaScript's `String(value)` of a JSON value and its `trim`, for stored text first written or
//! read so.
use crate::features::inventory_economics::ledger::fingerprint::js_float;

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
