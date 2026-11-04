//! Recordings the parity tests compare with (`tests/fixtures`), and what they keep of the store's
//! orders. TCGplayer's order numbers are recorded as aliases made from their hash
//! (`scripts/parity/scrub.ts`, which makes the same ones), so the public repo holds no order
//! number. A Rust answer is scrubbed the same way before it is compared, and a recorded request's
//! aliases are turned back into the dev database's order numbers before it is sent.
use std::{collections::HashMap, path::PathBuf, sync::LazyLock};

use regex::Regex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};

static ORDER_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[0-9A-F]{8}-[0-9A-F]{6}-[0-9A-F]{5}\b").unwrap());
static ALIAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bORDER-[0-9a-f]{12}\b").unwrap());

/// `tests/fixtures/<name>`, read as JSON.
pub fn read<T: DeserializeOwned>(name: &str) -> T {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// An order number's alias.
pub fn alias(order_number: &str) -> String {
    let digest = hex::encode(Sha256::digest(order_number.as_bytes()));
    format!("ORDER-{}", &digest[..12])
}

/// `text` with every order number in it aliased.
pub fn scrub_text(text: &str) -> String {
    ORDER_NUMBER
        .replace_all(text, |found: &regex::Captures| alias(&found[0]))
        .into_owned()
}

/// `value` with every order number in its keys and text aliased.
pub fn scrub(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(scrub_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(scrub).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, entry)| (scrub_text(&key), scrub(entry)))
                .collect(),
        ),
        other => other,
    }
}

/// The dev database's order numbers, by alias.
pub struct Orders(HashMap<String, String>);

impl Orders {
    pub async fn of_dev_database() -> Self {
        crate::config::load_env();
        let pool = sqlx::PgPool::connect(&crate::config::database_url())
            .await
            .unwrap();
        let numbers: Vec<String> = sqlx::query_scalar("SELECT order_number FROM seller_orders")
            .fetch_all(&pool)
            .await
            .unwrap();
        pool.close().await;
        Orders(
            numbers
                .into_iter()
                .map(|number| (alias(&number), number))
                .collect(),
        )
    }

    /// `text` with each alias in it turned back into its order number.
    pub fn real(&self, text: &str) -> String {
        ALIAS
            .replace_all(text, |found: &regex::Captures| {
                self.0
                    .get(&found[0])
                    .cloned()
                    .unwrap_or_else(|| panic!("{} is no order in the dev database", &found[0]))
            })
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The aliases are the ones `scripts/parity/scrub.ts` makes.
    #[test]
    fn an_order_number_is_aliased_by_its_hash() {
        assert_eq!(alias("ABCDEF12-345678-9ABCD"), "ORDER-38c2a122504c");
        assert_ne!(
            alias("ABCDEF12-345678-9ABCD"),
            alias("ABCDEF12-345678-9ABCE")
        );
        assert_eq!(
            scrub(json!({ "ABCDEF12-345678-9ABCD": ["order ABCDEF12-345678-9ABCD", 3] })),
            json!({ alias("ABCDEF12-345678-9ABCD"): [format!("order {}", alias("ABCDEF12-345678-9ABCD")), 3] })
        );
        let orders = Orders(HashMap::from([(
            alias("ABCDEF12-345678-9ABCD"),
            "ABCDEF12-345678-9ABCD".to_owned(),
        )]));
        assert_eq!(
            orders.real(&scrub_text(r#"{"orderNumber":"ABCDEF12-345678-9ABCD"}"#)),
            r#"{"orderNumber":"ABCDEF12-345678-9ABCD"}"#
        );
    }
}
