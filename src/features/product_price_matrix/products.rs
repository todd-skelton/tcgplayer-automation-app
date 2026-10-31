//! The products the matrix can show: a set's, or every set's with a card number, each with its
//! SKUs counted and its languages listed (`/api/product-price-matrix/products`).
use serde::Deserialize;

use crate::{
    database::Database,
    features::{
        inventory_intake::catalog::{NumberMatch, ProductType, Scope},
        inventory_strategy::collate,
    },
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

    /// The card number as a seller types it, so the picker finds the product by any of them and
    /// lists it first when one is typed whole: as written, with the number padded to the set's
    /// width and without (`4/102`, `004/102`), and the number alone (`4`).
    pub fn terms(&self) -> Vec<String> {
        let Some(number) = self
            .card_number
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
        else {
            return Vec::new();
        };
        let mut terms = vec![number.to_owned()];
        if let Some((left, right)) = number.split_once('/') {
            let bare = match left.trim_start_matches('0') {
                "" => "0",
                bare => bare,
            };
            let padded = format!("{bare:0>width$}/{right}", width = right.len());
            for term in [format!("{bare}/{right}"), padded, bare.to_owned()] {
                if !terms.contains(&term) {
                    terms.push(term);
                }
            }
        }
        terms
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

/// A product as the catalog stores it, with its card number in the set looked at.
#[derive(sqlx::FromRow)]
struct Row {
    product_id: i32,
    product_line_id: i32,
    product_name: String,
    rarity_name: Option<String>,
    sealed: bool,
    set_name: String,
    card_number: Option<String>,
    skus: sqlx::types::Json<Vec<SkuLanguage>>,
}

#[derive(Deserialize)]
struct SkuLanguage {
    language: String,
}

impl From<Row> for Product {
    /// `buildProductSummary`: its SKUs counted, and its languages English first, then in
    /// `localeCompare` order.
    fn from(row: Row) -> Product {
        let mut languages: Vec<String> = Vec::new();
        for sku in &row.skus.0 {
            if !languages.contains(&sku.language) {
                languages.push(sku.language.clone());
            }
        }
        languages.sort_by(|a, b| {
            (a != "English")
                .cmp(&(b != "English"))
                .then_with(|| collate::compare(a, b))
        });
        Product {
            product_id: row.product_id,
            product_line_id: row.product_line_id,
            product_name: row.product_name,
            rarity_name: row.rarity_name,
            sealed: row.sealed,
            set_name: row.set_name,
            card_number: row.card_number,
            sku_count: u32::try_from(row.skus.0.len()).unwrap_or(u32::MAX),
            languages,
        }
    }
}

const COLUMNS: &str = "p.product_id, p.product_line_id, p.product_name, p.rarity_name, p.sealed,
    p.set_name, p.skus_json AS skus";

/// The most products a card number finds across every set.
const MOST_FOUND: i64 = 250;

/// `createProductPriceMatrixProductsLoader`: a set's products in the order the catalog keeps
/// them, or the line's products with a matching card number by set and name, at most
/// [`MOST_FOUND`].
async fn found(db: &Database, line: i32, looking: &Looking<'_>) -> sqlx::Result<Vec<Product>> {
    let rows: Vec<Row> = match *looking {
        Looking::Set(set) => {
            sqlx::query_as(&format!(
                "SELECT {COLUMNS},
                    (SELECT sp.number FROM set_products sp
                     WHERE sp.set_name_id = $1 AND sp.product_id = p.product_id) AS card_number
                FROM products p WHERE p.set_id = $1 AND p.product_line_id = $2"
            ))
            .bind(set)
            .bind(line)
            .fetch_all(&db.0)
            .await?
        }
        Looking::AllSets(number) => {
            let Some(matching) = NumberMatch::of(number) else {
                return Ok(Vec::new());
            };
            sqlx::query_as(&format!(
                "SELECT {COLUMNS}, sp.number AS card_number
                FROM set_products sp JOIN products p ON p.product_id = sp.product_id
                WHERE p.product_line_id = $1 AND {}
                ORDER BY sp.set_name ASC, sp.product_name ASC LIMIT $4",
                matching.condition()
            ))
            .bind(line)
            .bind(matching.normalized)
            .bind(matching.raw)
            .bind(MOST_FOUND)
            .fetch_all(&db.0)
            .await?
        }
    };
    Ok(rows.into_iter().map(Product::from).collect())
}

/// The products to choose from, of the type shown. Every set's are looked up only by a card
/// number, so an empty one finds none.
pub async fn products(
    db: &Database,
    line: i32,
    looking: Looking<'_>,
    product_type: ProductType,
) -> Result<Vec<Product>, String> {
    let found = found(db, line, &looking).await.map_err(|e| e.to_string())?;
    Ok(found
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

    /// Each case `.port-logs/matrix-products-node.ts` asked Node's products route, on the dev
    /// database: a set's products, and card numbers searched across every set.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn products_read_as_node_reads_them() {
        #[derive(Deserialize)]
        struct Case {
            case: std::collections::HashMap<String, String>,
            body: Answer,
        }
        #[derive(Deserialize)]
        struct Answer {
            products: Vec<Product>,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let cases: Vec<Case> = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/matrix-products.node.json").unwrap(),
        )
        .unwrap();
        for Case { case, body } in cases {
            let line = case["productLineId"].parse().unwrap();
            let looking = match case["scope"].as_str() {
                "set" => Looking::Set(case["setId"].parse().unwrap()),
                _ => Looking::AllSets(&case["query"]),
            };
            let ours = found(&db, line, &looking).await.unwrap();
            assert_eq!(ours.len(), body.products.len(), "{case:?}");
            assert_eq!(ours, body.products, "{case:?}");
        }
    }

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
    fn a_card_number_is_found_padded_or_not_and_alone() {
        let numbered = |n: &str| Product {
            card_number: Some(n.into()),
            ..product(1, &[])
        };
        assert_eq!(numbered("4/102").terms(), ["4/102", "004/102", "4"]);
        assert_eq!(numbered("004/102").terms(), ["004/102", "4/102", "4"]);
        assert_eq!(numbered("SWSH236").terms(), ["SWSH236"]);
        assert!(numbered(" ").terms().is_empty());
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
