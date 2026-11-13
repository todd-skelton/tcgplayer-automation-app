//! What the intake screen offers to count: the product lines, a line's sets, and the products of
//! a set (or of every set, by card number), each with a SKU per condition. Read from the catalog
//! tables the catalog sync fills (`product_lines`, `category_sets`, `products`, `set_products`).
use std::collections::BTreeMap;

use corten::UrlValue;

use crate::database::Database;

/// The product line the screen starts on: Pokemon.
pub const DEFAULT_PRODUCT_LINE: i32 = 3;

/// A condition a card is counted in. Sealed products have one SKU, `Unopened`, whatever is
/// chosen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, UrlValue)]
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

/// The order the products are listed in, across every page: by name, either way. There is no
/// sort on Quantity: the products carry no quantity of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum ProductOrder {
    Name,
    NameDown,
}

impl ProductOrder {
    /// `products` in this order; they come by name, A to Z.
    pub fn apply<T>(self, mut products: Vec<T>) -> Vec<T> {
        if self == ProductOrder::NameDown {
            products.reverse();
        }
        products
    }
}

/// How many products a page shows (`pageSizeOptions`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue)]
pub enum PageSize {
    #[serde(rename = "25")]
    Rows25,
    #[serde(rename = "50")]
    Rows50,
    #[default]
    #[serde(rename = "100")]
    Rows100,
}

impl PageSize {
    pub const ALL: [PageSize; 3] = [PageSize::Rows25, PageSize::Rows50, PageSize::Rows100];

    pub fn count(self) -> usize {
        match self {
            PageSize::Rows25 => 25,
            PageSize::Rows50 => 50,
            PageSize::Rows100 => 100,
        }
    }
}

/// One page of `items`, counting from 1, and how many pages there are (at least one). A page
/// past the end is the last.
pub fn page_of<T>(items: Vec<T>, page: usize, size: PageSize) -> (Vec<T>, usize, usize) {
    let size = size.count();
    let pages = items.len().div_ceil(size).max(1);
    let page = page.clamp(1, pages);
    let kept = items
        .into_iter()
        .skip((page - 1) * size)
        .take(size)
        .collect();
    (kept, page, pages)
}

/// Which products show: sealed, unsealed, or both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum ProductType {
    All,
    SealedOnly,
    #[default]
    UnsealedOnly,
}

impl ProductType {
    pub fn shows(self, sealed: bool) -> bool {
        match self {
            ProductType::All => true,
            ProductType::SealedOnly => sealed,
            ProductType::UnsealedOnly => !sealed,
        }
    }
}

/// Where the search looks: the chosen set's products by name or number, or every set of the
/// line by card number.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    #[default]
    Set,
    AllSets,
}

/// The languages the language filter offers.
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
        "SELECT {SKU_COLUMNS}, sp.number AS card_number,
            (SELECT cs.release_date FROM category_sets cs WHERE cs.category_id = $2 AND cs.set_name_id = $1) AS release_date
         FROM products p
         LEFT JOIN set_products sp ON sp.product_id = p.product_id AND sp.set_name_id = $1
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
    let Some(matching) = NumberMatch::of(number) else {
        return Ok(Vec::new());
    };
    sqlx::query_as(&format!(
        "SELECT {SKU_COLUMNS}, sp.number AS card_number, cs.release_date
         FROM set_products sp
         JOIN products p ON p.product_id = sp.product_id
         LEFT JOIN category_sets cs ON cs.category_id = p.product_line_id AND cs.set_name_id = sp.set_name_id
         CROSS JOIN LATERAL jsonb_to_recordset(p.skus_json) AS s(sku int, condition text, variant text, language text)
         WHERE p.product_line_id = $1 AND {}",
        matching.condition()
    ))
    .bind(product_line)
    .bind(matching.normalized)
    .bind(matching.raw)
    .fetch_all(&db.0)
    .await
}

/// How `set_products.number` (as `sp`) is matched to a card number typed, as
/// `setProductsRepository.findByCardNumber` matches it: whole when it has a `/`, else by the number
/// before it, and as text too when it has letters.
pub(crate) struct NumberMatch {
    column: &'static str,
    /// Bound as `$2`.
    pub normalized: String,
    /// Bound as `$3`: the text to find anywhere in the number, when it is searched as text.
    pub raw: Option<String>,
}

impl NumberMatch {
    /// None for a blank number, which matches nothing.
    pub fn of(number: &str) -> Option<NumberMatch> {
        let number = number.trim();
        if number.is_empty() {
            return None;
        }
        let (column, normalized) = if number.contains('/') {
            ("normalize_card_number(sp.number)", normalize_value(number))
        } else {
            (
                "normalize_card_number_prefix(sp.number)",
                normalize_prefix(number),
            )
        };
        Some(NumberMatch {
            column,
            normalized,
            raw: searches_raw_text(number).then(|| format!("%{}%", escape_like(number))),
        })
    }

    /// The SQL condition, over `$2` and `$3`.
    pub fn condition(&self) -> String {
        format!(
            "({} = $2 OR ($3::text IS NOT NULL AND sp.number ILIKE $3 ESCAPE '\\'))",
            self.column
        )
    }
}

/// The product a SKU counts, as its row draws it, and the SKU's condition (none when sealed).
pub async fn counted(
    db: &Database,
    sku: i32,
) -> sqlx::Result<Option<(Product, Option<Condition>)>> {
    let found: Option<Sku> = sqlx::query_as(&format!(
        "SELECT {SKU_COLUMNS},
            (SELECT sp.number FROM set_products sp WHERE sp.set_name_id = p.set_id AND sp.product_id = p.product_id LIMIT 1) AS card_number,
            (SELECT cs.release_date FROM category_sets cs WHERE cs.category_id = p.product_line_id AND cs.set_name_id = p.set_id) AS release_date
         FROM skus s
         JOIN products p ON p.product_id = s.product_id
         WHERE s.sku = $1"
    ))
    .bind(sku)
    .fetch_optional(&db.0)
    .await?;
    let Some(sku) = found else {
        return Ok(None);
    };
    let condition = Condition::of(&sku.condition).filter(|_| !sku.sealed);
    let shown = Shown {
        product_type: ProductType::All,
        languages: &[],
    };
    Ok(products(vec![sku], &shown)
        .into_iter()
        .next()
        .map(|product| (product, condition)))
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
/// otherwise those whose name has the text. The screen's script searches a set the same way
/// (`views/set_search.js`), and a test runs the same cases through both.
pub fn search<'a>(products: &'a [Product], query: &str) -> Vec<&'a Product> {
    let query = query.trim();
    if query.is_empty() {
        return products.iter().collect();
    }
    let by_number: Vec<&Product> = products
        .iter()
        .filter(|p| matches_number(query, p.card_number.as_deref()))
        .collect();
    if !by_number.is_empty() {
        return by_number;
    }
    let query = query.to_lowercase();
    products
        .iter()
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

    /// 250 products are three pages of 100; a page past the end is the last, and none is one.
    #[test]
    fn products_are_paged_as_the_react_grid_paged_them() {
        let items: Vec<u32> = (1..=250).collect();
        let (kept, page, pages) = page_of(items.clone(), 1, PageSize::default());
        assert_eq!(
            (kept.first(), kept.len(), page, pages),
            (Some(&1), 100, 1, 3)
        );
        let (kept, page, _) = page_of(items.clone(), 3, PageSize::Rows100);
        assert_eq!((kept.first(), kept.len(), page), (Some(&201), 50, 3));
        let (kept, page, _) = page_of(items.clone(), 9, PageSize::Rows25);
        assert_eq!((kept.first(), page), (Some(&201), 9));
        let (kept, page, _) = page_of(items.clone(), 99, PageSize::Rows25);
        assert_eq!((kept.first(), page), (Some(&226), 10));
        let (kept, page, pages) = page_of(Vec::<u32>::new(), 0, PageSize::Rows50);
        assert_eq!((kept.len(), page, pages), (0, 1, 1));
    }

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
        let found = search(&rows, "25");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].product_id, 10);
        assert_eq!(search(&rows, "raichu").len(), 1);
        assert_eq!(search(&rows, "  ").len(), 2);
    }

    /// A set's products, and searches of it with the products each finds, in order: the server's
    /// `search` and the script's (`views/set_search.js`) find the same ones.
    const SET: &[(i32, &str, Option<&str>)] = &[
        (1, "Pikachu - 025/165 - Common", Some("025/165")),
        (2, "Raichu - 026/165 - Rare", Some("026/165")),
        (
            3,
            "Pikachu ex - 247/165 - Special Illustration Rare",
            Some("247/165"),
        ),
        (4, "Basic Lightning Energy", None),
        (5, "Charizard - SWSH050 - Promo", Some("SWSH050")),
        (6, "Mew - 151/165 - Rare", Some("151/165")),
        (7, "Piplup - TG25/TG30 - Trainer Gallery", Some("TG25/TG30")),
        (8, "Cosmog - 000/165 - Common", Some("000/165")),
        (9, "Caf\u{c9} Crew - 10/12 - Promo", Some("10/12")),
    ];
    const SEARCHES: &[(&str, &[i32])] = &[
        ("25", &[1]),
        ("025/165", &[1]),
        ("25/165", &[1]),
        (" 026 ", &[2]),
        ("+25", &[1]),
        ("0", &[8]),
        ("151", &[6]),
        ("10/12", &[9]),
        ("SWSH050", &[5]),
        ("TG25/TG30", &[7]),
        // No card number matches: the names that have the text, whatever its case.
        ("3/12", &[]),
        ("swsh050", &[5]),
        ("pika", &[1, 3]),
        ("PIKACHU EX", &[3]),
        ("  raichu  ", &[2]),
        ("energy", &[4]),
        ("caf\u{e9}", &[9]),
        ("1", &[1, 2, 3, 6, 8, 9]),
        ("/", &[1, 2, 3, 6, 7, 8, 9]),
        ("", &[1, 2, 3, 4, 5, 6, 7, 8, 9]),
        ("   ", &[1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ];

    fn set() -> Vec<Product> {
        SET.iter()
            .map(|&(id, name, number)| Product {
                product_id: id,
                display_name: name.into(),
                set_name: "Set".into(),
                release_year: None,
                card_number: number.map(Into::into),
                variant: "Normal".into(),
                sealed: false,
                set_id: 1,
                product_line_id: 3,
                unopened: None,
                skus: [Some(id), None, None, None, None],
            })
            .collect()
    }

    #[test]
    fn the_script_searches_a_set_as_the_server_does() {
        let products = set();
        for (query, found) in SEARCHES {
            let ids: Vec<i32> = search(&products, query)
                .iter()
                .map(|p| p.product_id)
                .collect();
            assert_eq!(ids, *found, "{query:?}");
        }
        // The same searches through the script's export, over the products as the page sends
        // them (a card number without one is empty). The test runs in the crate's directory.
        let listed: Vec<serde_json::Value> = SET
            .iter()
            .map(|&(id, name, number)| {
                serde_json::json!({ "id": id, "name": name, "number": number.unwrap_or("") })
            })
            .collect();
        let queries: Vec<&str> = SEARCHES.iter().map(|(query, _)| *query).collect();
        let script = format!(
            "import {{ search }} from './src/features/inventory_intake/views/set_search.js';
             const products = {};
             for (const query of {}) console.log(search(products, query).map((p) => p.id).join(','));",
            serde_json::Value::from(listed),
            serde_json::json!(queries),
        );
        let out = std::process::Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .output()
            .expect("node runs");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let lines: Vec<String> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        let expected: Vec<String> = SEARCHES
            .iter()
            .map(|(_, found)| {
                found
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect();
        assert_eq!(lines, expected);
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
