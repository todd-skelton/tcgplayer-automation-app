//! The products the matrix can show: a set's, narrowed to a search, or every set's with a card
//! number (`/api/product-price-matrix/products`, the Node app's, which also counts each product's
//! SKUs and lists its languages).
use serde::{Deserialize, Serialize};

use crate::{
    features::inventory_intake::catalog::{ProductType, Scope},
    legacy::Legacy,
};

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub product_id: i32,
    pub product_line_id: i32,
    pub product_name: String,
    #[serde(default)]
    pub rarity_name: Option<String>,
    pub sealed: bool,
    pub set_name: String,
    #[serde(default)]
    pub card_number: Option<String>,
    pub sku_count: u32,
    #[serde(default)]
    pub languages: Vec<String>,
}

impl Product {
    /// `025/198 - Pikachu - Scarlet & Violet`, as the product picker labels it.
    pub fn label(&self) -> String {
        match self.card_number.as_deref().filter(|n| !n.is_empty()) {
            Some(number) => format!("{number} - {} - {}", self.product_name, self.set_name),
            None => format!("{} - {}", self.product_name, self.set_name),
        }
    }

    /// The language a product opens in: English when it has it, else its first.
    pub fn default_language(&self) -> Option<&str> {
        self.languages
            .iter()
            .find(|l| *l == "English")
            .or(self.languages.first())
            .map(String::as_str)
    }

    /// `language` when the product has it, else the one it opens in.
    pub fn language<'a>(&'a self, language: Option<&'a str>) -> Option<&'a str> {
        language
            .filter(|l| self.languages.iter().any(|known| known == l))
            .or_else(|| self.default_language())
    }
}

/// Where to look: a set, or every set of the line by card number.
pub enum Looking<'a> {
    Set(i32),
    AllSets(&'a str),
}

/// The products to choose from, of the type shown. Every set's are looked up only by a card
/// number, so an empty one finds none without asking.
pub async fn products(
    legacy: &Legacy,
    line: i32,
    looking: Looking<'_>,
    product_type: ProductType,
) -> Result<Vec<Product>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Query<'a> {
        product_line_id: i32,
        scope: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        set_id: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<&'a str>,
    }
    #[derive(Deserialize)]
    struct Answer {
        products: Vec<Product>,
    }
    let query = match looking {
        Looking::Set(set) => Query {
            product_line_id: line,
            scope: "set",
            set_id: Some(set),
            query: None,
        },
        Looking::AllSets(number) if number.trim().is_empty() => return Ok(Vec::new()),
        Looking::AllSets(number) => Query {
            product_line_id: line,
            scope: "allSets",
            set_id: None,
            query: Some(number.trim()),
        },
    };
    let answer: Answer = legacy
        .read_with("/api/product-price-matrix/products", &query)
        .await?;
    Ok(answer
        .products
        .into_iter()
        .filter(|p| product_type.shows(p.sealed))
        .collect())
}

/// What the scope says to look at, with the set chosen and the card number typed.
pub fn looking(scope: Scope, set: Option<i32>, number: &str) -> Option<Looking<'_>> {
    match scope {
        Scope::Set => set.map(Looking::Set),
        Scope::AllSets => Some(Looking::AllSets(number)),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn product(id: i32, languages: &[&str]) -> Product {
        Product {
            product_id: id,
            product_line_id: 3,
            product_name: "Pikachu".into(),
            rarity_name: Some("Common".into()),
            sealed: false,
            set_name: "Base Set".into(),
            card_number: Some("58/102".into()),
            sku_count: 10,
            languages: languages.iter().map(|l| (*l).to_owned()).collect(),
        }
    }

    #[test]
    fn a_product_opens_in_english_when_it_has_it() {
        assert_eq!(
            product(1, &["Japanese", "English"]).default_language(),
            Some("English")
        );
        assert_eq!(
            product(1, &["Japanese"]).default_language(),
            Some("Japanese")
        );
        let p = product(1, &["Japanese", "English"]);
        assert_eq!(p.language(Some("Japanese")), Some("Japanese"));
        assert_eq!(p.language(Some("French")), Some("English"));
        assert_eq!(p.label(), "58/102 - Pikachu - Base Set");
    }

    #[test]
    fn the_answer_reads_the_node_apps_json() {
        let json = serde_json::json!({
            "productId": 42, "productLineId": 3, "productLineName": "Pokemon",
            "productName": "Pikachu", "displayName": "Pikachu", "productTypeName": "Cards",
            "rarityName": null, "sealed": false, "setId": 1, "setCode": "BS",
            "setName": "Base Set", "cardNumber": null, "skuCount": 30,
            "conditions": ["Near Mint"], "variants": ["Normal"], "languages": ["English"]
        });
        let p: Product = serde_json::from_value(json).unwrap();
        assert_eq!(
            (p.product_id, p.card_number.as_deref(), p.sku_count),
            (42, None, 30)
        );
        assert_eq!(p.label(), "Pikachu - Base Set");
    }
}
