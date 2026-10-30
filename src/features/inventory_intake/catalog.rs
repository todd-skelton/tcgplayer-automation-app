//! What the intake screen offers to count: the product lines, a line's sets, and the products of
//! a set (or of every set, by card number), each with a SKU per condition. Read from the catalog
//! tables the Node sync fills (`product_lines`, `category_sets`, `products`, `set_products`).
use std::collections::BTreeMap;

use corten::UrlValue;
use serde::Deserialize;

use crate::database::Database;

/// The product line the screen starts on, as the React screen did: Pokemon.
pub const DEFAULT_PRODUCT_LINE: i32 = 3;

/// A condition a card is counted in. Sealed products have one SKU, `Unopened`, whatever is
/// chosen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Condition {
    #[default]
    NearMint,
    LightlyPlayed,
    ModeratelyPlayed,
    HeavilyPlayed,
    Damaged,
}

impl Condition {
    /// In the order the shortcuts step through them.
    pub const ALL: [Condition; 5] = [
        Condition::NearMint,
        Condition::LightlyPlayed,
        Condition::ModeratelyPlayed,
        Condition::HeavilyPlayed,
        Condition::Damaged,
    ];

    /// The name the catalog's SKUs carry.
    pub fn name(self) -> &'static str {
        match self {
            Condition::NearMint => "Near Mint",
            Condition::LightlyPlayed => "Lightly Played",
            Condition::ModeratelyPlayed => "Moderately Played",
            Condition::HeavilyPlayed => "Heavily Played",
            Condition::Damaged => "Damaged",
        }
    }

    fn of(name: &str) -> Option<Condition> {
        Condition::ALL.into_iter().find(|c| c.name() == name)
    }

    /// Its place in [`Condition::ALL`].
    pub fn index(self) -> usize {
        self as usize
    }
}

/// Which products show: sealed, unsealed, or both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProductType {
    All,
    SealedOnly,
    #[default]
    UnsealedOnly,
}

impl ProductType {
    fn shows(self, sealed: bool) -> bool {
        match self {
            ProductType::All => true,
            ProductType::SealedOnly => sealed,
            ProductType::UnsealedOnly => !sealed,
        }
    }
}

/// Where the search looks: the chosen set's products by name or number, or every set of the
/// line by card number.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    #[default]
    Set,
    AllSets,
}

/// The languages the language filter offers, as the React screen listed them.
pub const LANGUAGES: [&str; 11] = [
    "English",
    "Japanese",
    "French",
    "German",
    "Spanish",
    "Italian",
    "Chinese (S)",
    "Portuguese",
    "Chinese (T)",
    "Russian",
    "Korean",
];

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ProductLine {
    pub id: i32,
    pub name: String,
}

pub async fn product_lines(db: &Database) -> sqlx::Result<Vec<ProductLine>> {
    sqlx::query_as(
        "SELECT product_line_id AS id, product_line_name AS name FROM product_lines ORDER BY product_line_name",
    )
    .fetch_all(&db.0)
    .await
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Set {
    pub id: i32,
    pub name: String,
    pub abbreviation: Option<String>,
    pub release_date: Option<String>,
}

impl Set {
    /// `SV10 - Destined Rivals - 5/30/2025`, as the set picker labels it.
    pub fn label(&self) -> String {
        let mut label = String::new();
        if let Some(abbreviation) = self.abbreviation.as_deref().filter(|a| !a.is_empty()) {
            label.push_str(abbreviation);
            label.push_str(" - ");
        }
        label.push_str(&self.name);
        if let Some(date) = self.release_date.as_deref().and_then(short_date) {
            label.push_str(" - ");
            label.push_str(&date);
        }
        label
    }
}

/// `2025-05-30T00:00:00` as `5/30/2025`.
fn short_date(date: &str) -> Option<String> {
    let day = chrono::NaiveDate::parse_from_str(date.get(..10)?, "%Y-%m-%d").ok()?;
    Some(day.format("%-m/%-d/%Y").to_string())
}

/// A line's active sets, newest first, those without a release date last: the order Page Up and
/// Page Down step through, and the first is the set the screen starts on.
pub async fn sets(db: &Database, product_line: i32) -> sqlx::Result<Vec<Set>> {
    let mut sets: Vec<Set> = sqlx::query_as(
        "SELECT set_name_id AS id, name, abbreviation, release_date FROM category_sets
         WHERE category_id = $1 AND name NOT LIKE '[Inactive%'",
    )
    .bind(product_line)
    .fetch_all(&db.0)
    .await?;
    sets.sort_by(|a, b| match (&a.release_date, &b.release_date) {
        (Some(a), Some(b)) => b.cmp(a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });
    Ok(sets)
}

/// One SKU of a product, with what the row shows about the product.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Sku {
    pub sku: i32,
    pub condition: String,
    pub variant: String,
    pub language: String,
    pub product_id: i32,
    pub product_name: String,
    pub rarity_name: Option<String>,
    pub sealed: bool,
    pub set_id: i32,
    pub set_name: String,
    pub product_line_id: i32,
    pub card_number: Option<String>,
    pub release_date: Option<String>,
}

const SKU_COLUMNS: &str = "s.sku, s.condition, s.variant, s.language, p.product_id, p.product_name,
    p.rarity_name, p.sealed, p.set_id, p.set_name, p.product_line_id";

/// Every SKU of a set's products.
pub async fn set_skus(db: &Database, product_line: i32, set: i32) -> sqlx::Result<Vec<Sku>> {
    sqlx::query_as(&format!(
        "SELECT {SKU_COLUMNS},
            (SELECT sp.number FROM set_products sp WHERE sp.set_name_id = $1 AND sp.product_id = p.product_id LIMIT 1) AS card_number,
            (SELECT cs.release_date FROM category_sets cs WHERE cs.category_id = $2 AND cs.set_name_id = $1) AS release_date
         FROM products p
         CROSS JOIN LATERAL jsonb_to_recordset(p.skus_json) AS s(sku int, condition text, variant text, language text)
         WHERE p.set_id = $1 AND p.product_line_id = $2"
    ))
    .bind(set)
    .bind(product_line)
    .fetch_all(&db.0)
    .await
}

/// Every SKU of the line's products whose card number matches, in any set: `3` finds `003/120`,
/// `3/120` finds `003/120`, and text with letters (`SWSH050`) also finds numbers containing it.
pub async fn card_number_skus(
    db: &Database,
    product_line: i32,
    number: &str,
) -> sqlx::Result<Vec<Sku>> {
    let number = number.trim();
    if number.is_empty() {
        return Ok(Vec::new());
    }
    let (column, normalized) = if number.contains('/') {
        ("normalize_card_number(sp.number)", normalize_value(number))
    } else {
        (
            "normalize_card_number_prefix(sp.number)",
            normalize_prefix(number),
        )
    };
    let raw = searches_raw_text(number).then(|| format!("%{}%", escape_like(number)));
    sqlx::query_as(&format!(
        "SELECT {SKU_COLUMNS}, sp.number AS card_number, cs.release_date
         FROM set_products sp
         JOIN products p ON p.product_id = sp.product_id
         LEFT JOIN category_sets cs ON cs.category_id = p.product_line_id AND cs.set_name_id = sp.set_name_id
         CROSS JOIN LATERAL jsonb_to_recordset(p.skus_json) AS s(sku int, condition text, variant text, language text)
         WHERE p.product_line_id = $1 AND ({column} = $2 OR ($3::text IS NOT NULL AND sp.number ILIKE $3 ESCAPE '\'))"
    ))
    .bind(product_line)
    .bind(normalized)
    .bind(raw)
    .fetch_all(&db.0)
    .await
}

/// One row of the table: a product in one printing and language, with its SKU per condition.
#[derive(Clone, Debug)]
pub struct Product {
    pub product_id: i32,
    pub display_name: String,
    pub set_name: String,
    pub release_year: Option<String>,
    pub card_number: Option<String>,
    pub variant: String,
    pub sealed: bool,
    pub set_id: i32,
    pub product_line_id: i32,
    /// The sealed product's one SKU.
    pub unopened: Option<i32>,
    /// Its SKU in each condition, by [`Condition::index`].
    pub skus: [Option<i32>; 5],
}

impl Product {
    /// The SKU counted under `condition`: a sealed product's only SKU, or none in that condition.
    pub fn sku(&self, condition: Condition) -> Option<i32> {
        if self.sealed {
            return self.unopened;
        }
        self.skus[condition.index()]
    }
}

/// `Pikachu - 025/165 - Common - Japanese`: the name, the number when the name lacks it, the
/// rarity, and the language unless English.
fn display_name(sku: &Sku) -> String {
    let mut parts = vec![sku.product_name.as_str()];
    if let Some(number) = sku
        .card_number
        .as_deref()
        .filter(|n| !n.is_empty() && !sku.product_name.contains(n))
    {
        parts.push(number);
    }
    if let Some(rarity) = sku.rarity_name.as_deref().filter(|r| !r.is_empty()) {
        parts.push(rarity);
    }
    if !sku.language.is_empty() && sku.language != "English" {
        parts.push(&sku.language);
    }
    parts.join(" - ")
}

/// What the filters keep of the SKUs read.
pub struct Shown<'a> {
    pub product_type: ProductType,
    pub languages: &'a [String],
}

/// The SKUs as rows, one per product, printing and language, sorted by name then printing.
pub fn products(skus: Vec<Sku>, shown: &Shown) -> Vec<Product> {
    let mut rows: BTreeMap<(i32, String, String), Product> = BTreeMap::new();
    for sku in skus {
        if !shown.product_type.shows(sku.sealed) {
            continue;
        }
        if !shown.languages.is_empty() && !shown.languages.contains(&sku.language) {
            continue;
        }
        let key = (sku.product_id, sku.variant.clone(), sku.language.clone());
        let row = rows.entry(key).or_insert_with(|| Product {
            product_id: sku.product_id,
            display_name: display_name(&sku),
            set_name: sku.set_name.clone(),
            release_year: sku
                .release_date
                .as_deref()
                .and_then(|d| d.get(..4))
                .map(str::to_owned),
            card_number: sku.card_number.clone(),
            variant: sku.variant.clone(),
            sealed: sku.sealed,
            set_id: sku.set_id,
            product_line_id: sku.product_line_id,
            unopened: None,
            skus: [None; 5],
        });
        if sku.condition == "Unopened" {
            row.unopened = Some(sku.sku);
        } else if let Some(condition) = Condition::of(&sku.condition) {
            row.skus[condition.index()] = Some(sku.sku);
        }
    }
    let mut rows: Vec<Product> = rows.into_values().collect();
    rows.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
            .then_with(|| a.variant.cmp(&b.variant))
    });
    rows
}

/// A set's products narrowed to a search: those whose card number matches when any does,
/// otherwise those whose name has the text.
pub fn search(products: Vec<Product>, query: &str) -> Vec<Product> {
    let query = query.trim();
    if query.is_empty() {
        return products;
    }
    let by_number: Vec<bool> = products
        .iter()
        .map(|p| matches_number(query, p.card_number.as_deref()))
        .collect();
    if by_number.contains(&true) {
        return products
            .into_iter()
            .zip(by_number)
            .filter_map(|(p, hit)| hit.then_some(p))
            .collect();
    }
    let query = query.to_lowercase();
    products
        .into_iter()
        .filter(|p| p.display_name.to_lowercase().contains(&query))
        .collect()
}

/// A number without its leading zeros, as JavaScript's `parseInt` reads one: `003` is `3`, `12a`
/// is `12`, and text that starts with no digit is kept as it is.
fn normalize_part(part: &str) -> String {
    let trimmed = part.trim_start();
    let (sign, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return part.to_owned();
    }
    let number = digits.trim_start_matches('0');
    match number {
        "" => "0".to_owned(),
        n => format!("{sign}{n}"),
    }
}

fn normalize_value(value: &str) -> String {
    value
        .trim()
        .split('/')
        .map(|p| normalize_part(p.trim()))
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_prefix(value: &str) -> String {
    normalize_part(value.trim().split('/').next().unwrap_or("").trim())
}

fn searches_raw_text(query: &str) -> bool {
    query
        .trim()
        .chars()
        .any(|c| !(c.is_ascii_digit() || c == '/' || c.is_whitespace()))
}

fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Whether a card number matches a query: without a slash, the part before the field's first
/// slash; with one, every part; each part without its leading zeros.
pub fn matches_number(query: &str, field: Option<&str>) -> bool {
    let (query, field) = (query.trim(), field.unwrap_or("").trim());
    if query.is_empty() || field.is_empty() {
        return false;
    }
    if query.contains('/') {
        let (q, f): (Vec<&str>, Vec<&str>) =
            (query.split('/').collect(), field.split('/').collect());
        return q.len() == f.len()
            && q.iter()
                .zip(&f)
                .all(|(q, f)| normalize_part(q) == normalize_part(f));
    }
    normalize_part(query) == normalize_prefix(field)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sku(
        sku: i32,
        product: i32,
        name: &str,
        condition: &str,
        variant: &str,
        number: Option<&str>,
    ) -> Sku {
        Sku {
            sku,
            condition: condition.into(),
            variant: variant.into(),
            language: "English".into(),
            product_id: product,
            product_name: name.into(),
            rarity_name: Some("Common".into()),
            sealed: condition == "Unopened",
            set_id: 1,
            set_name: "Base".into(),
            product_line_id: 3,
            card_number: number.map(Into::into),
            release_date: Some("1999-01-09T00:00:00".into()),
        }
    }

    #[test]
    fn numbers_match_as_the_react_screen_matched_them() {
        assert!(matches_number("3", Some("003/120")));
        assert!(matches_number("003", Some("3/120")));
        assert!(matches_number("3/120", Some("003/120")));
        assert!(matches_number("137", Some("137")));
        assert!(!matches_number("3/12", Some("003/120")));
        assert!(!matches_number("4", Some("003/120")));
        assert!(!matches_number("3", None));
        assert_eq!(normalize_part("12a"), "12");
        assert_eq!(normalize_part("SV"), "SV");
        assert_eq!(normalize_part("000"), "0");
    }

    #[test]
    fn a_query_with_letters_also_searches_the_text() {
        assert!(searches_raw_text("SWSH050"));
        assert!(!searches_raw_text("050/195"));
        assert_eq!(escape_like("50%_\\"), "50\\%\\_\\\\");
    }

    #[test]
    fn skus_are_grouped_by_product_printing_and_language() {
        let skus = vec![
            sku(1, 10, "Pikachu", "Near Mint", "Normal", Some("025/165")),
            sku(2, 10, "Pikachu", "Damaged", "Normal", Some("025/165")),
            sku(
                3,
                10,
                "Pikachu",
                "Near Mint",
                "Reverse Holofoil",
                Some("025/165"),
            ),
            sku(4, 11, "Booster Box", "Unopened", "Normal", None),
            sku(5, 12, "Abra", "Near Mint", "Normal", Some("063/165")),
        ];
        let all = Shown {
            product_type: ProductType::All,
            languages: &[],
        };
        let rows = products(skus.clone(), &all);
        let names: Vec<_> = rows
            .iter()
            .map(|r| (r.display_name.as_str(), r.variant.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("Abra - 063/165 - Common", "Normal"),
                ("Booster Box - Common", "Normal"),
                ("Pikachu - 025/165 - Common", "Normal"),
                ("Pikachu - 025/165 - Common", "Reverse Holofoil"),
            ]
        );
        let pikachu = &rows[2];
        assert_eq!(pikachu.sku(Condition::Damaged), Some(2));
        assert_eq!(pikachu.sku(Condition::LightlyPlayed), None);
        assert_eq!(
            rows[1].sku(Condition::Damaged),
            Some(4),
            "a sealed product has one SKU"
        );
        assert_eq!(rows[0].release_year.as_deref(), Some("1999"));

        let unsealed = Shown {
            product_type: ProductType::UnsealedOnly,
            languages: &[],
        };
        assert_eq!(products(skus, &unsealed).len(), 3);
    }

    #[test]
    fn a_search_finds_card_numbers_before_names() {
        let skus = vec![
            sku(1, 10, "Pikachu", "Near Mint", "Normal", Some("025/165")),
            sku(2, 11, "Raichu 25", "Near Mint", "Normal", Some("026/165")),
        ];
        let rows = products(
            skus,
            &Shown {
                product_type: ProductType::All,
                languages: &[],
            },
        );
        let found = search(rows.clone(), "25");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].product_id, 10);
        assert_eq!(search(rows.clone(), "raichu").len(), 1);
        assert_eq!(search(rows, "  ").len(), 2);
    }

    #[test]
    fn a_set_is_labeled_with_its_abbreviation_and_release() {
        let set = Set {
            id: 1,
            name: "Destined Rivals".into(),
            abbreviation: Some("SV10".into()),
            release_date: Some("2025-05-30T00:00:00".into()),
        };
        assert_eq!(set.label(), "SV10 - Destined Rivals - 5/30/2025");
    }
}
