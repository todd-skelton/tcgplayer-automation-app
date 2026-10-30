//! Fingerprints of evidence: a SHA-256 of its JSON with keys sorted, written as the Node app's
//! `stableJson` writes it, so a fingerprint recorded there matches one computed here.
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// `value` as JSON with every object's keys sorted and numbers written as JavaScript writes
/// them (`10`, not `10.0`).
pub fn stable_json(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write(&object[key], out);
            }
            out.push('}');
        }
        Value::Number(number) => out.push_str(&js_number(number)),
        other => out.push_str(&other.to_string()),
    }
}

/// A number as `JSON.stringify` writes it: whole values without a fraction, the shortest
/// digits that read back the same otherwise, and an exponent from 1e21 up or below 1e-6.
fn js_number(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    number.as_f64().map_or_else(|| "null".into(), js_float)
}

/// An f64 as `JSON.stringify` writes it; not finite is `null`.
fn js_float(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        // Rust's Display writes the shortest round-tripping digits without an exponent.
        return format!("{value}");
    }
    // Shortest digits with an exponent, in JavaScript's form: `1e+21`, `1.5e-7`.
    let written = format!("{value:e}");
    match written.split_once('e') {
        Some((digits, exponent)) if !exponent.starts_with('-') => format!("{digits}e+{exponent}"),
        _ => written,
    }
}

/// Writes numbers as JavaScript does, everything else as serde_json does.
struct JsFormatter;

impl serde_json::ser::Formatter for JsFormatter {
    fn write_f64<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: f64,
    ) -> std::io::Result<()> {
        writer.write_all(js_float(value).as_bytes())
    }

    fn write_f32<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: f32,
    ) -> std::io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }
}

/// `value` as `JSON.stringify` writes the same object: fields in the order they are declared,
/// numbers as JavaScript writes them.
pub fn js_json<T: Serialize + ?Sized>(value: &T) -> String {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
    value
        .serialize(&mut serializer)
        .expect("a value that serializes to JSON");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

/// The SHA-256 of `text`, in lowercase hex.
pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// The fingerprint of an order's financial records: its transaction and refund evidence. A
/// refund settlement recorded against one fingerprint applies only while the records match.
pub fn financial(transaction: &Value, refunds: &Value) -> String {
    let evidence = serde_json::json!({ "transaction": transaction, "refunds": refunds });
    sha256_hex(&stable_json(&evidence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_sorted_and_numbers_written_as_javascript_writes_them() {
        let value: Value =
            serde_json::from_str(r#"{"b":[1,10.0,1.5,1e21,1.5e-7],"a":{"d":null,"c":"x\"y"}}"#)
                .unwrap();
        assert_eq!(
            stable_json(&value),
            r#"{"a":{"c":"x\"y","d":null},"b":[1,10,1.5,1e+21,1.5e-7]}"#
        );
    }

    #[test]
    fn the_financial_fingerprint_matches_the_node_app() {
        // Node: createHash("sha256").update(stableJson({transaction:{net:8.64,lines:[{q:2,p:10.0}]},
        // refunds:[{amount:1.5}]})).digest("hex")
        assert_eq!(
            financial(
                &json!({ "net": 8.64, "lines": [{ "q": 2, "p": 10.0 }] }),
                &json!([{ "amount": 1.5 }])
            ),
            "c78e2e7bbdb809712c454f9e4c46891c0492c21d6c69e0170f866aa25c77f56a"
        );
    }
}
