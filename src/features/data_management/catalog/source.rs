//! TCGplayer's catalog as the jobs read it: product lines and their filters, a product line's
//! sets, a product's details, and the search, which finds a set's products and counts every
//! set's (`get-product-lines`, `get-category-filters`, `get-catalog-set-names`,
//! `get-product-details`, `get-search-results`). Each answer is read into what the jobs keep of it.
use serde::Deserialize;
use serde_json::{Value, json};

use super::store::{CategorySet, ProductLine, SetProduct};
use crate::{
    features::http_configuration::config::Domain,
    tcgplayer::{Call, TcgPlayer},
};

/// Where the catalog is read: a GET on a TCGplayer domain, or a search request, answered as JSON.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Catalog {
    async fn get(&self, domain: Domain, path: &str) -> Result<Value, String>;
    async fn search(&self, body: &Value) -> Result<Value, String>;
}

/// TCGplayer, through the app's client and its rate limits.
#[derive(Clone)]
pub struct TcgPlayerCatalog(pub TcgPlayer);

impl Catalog for TcgPlayerCatalog {
    async fn get(&self, domain: Domain, path: &str) -> Result<Value, String> {
        self.0
            .get(domain, path, Call::default())
            .await
            .map_err(|e| e.to_string())
    }

    async fn search(&self, body: &Value) -> Result<Value, String> {
        self.0
            .post(
                Domain::MpSearchApi,
                "/v1/search/request",
                body,
                Call::default(),
            )
            .await
            .map_err(|e| e.to_string())
    }
}

fn read<T: serde::de::DeserializeOwned>(answer: Value) -> Result<T, String> {
    serde_json::from_value(answer).map_err(|e| format!("TCGplayer's answer could not be read: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    product_line_id: i32,
    product_line_name: String,
    product_line_url_name: String,
    #[serde(default)]
    is_direct: bool,
}

/// Every product line (`getProductLines`).
pub async fn product_lines(catalog: &impl Catalog) -> Result<Vec<ProductLine>, String> {
    let lines: Option<Vec<Line>> = read(
        catalog
            .get(Domain::MpSearchApi, "/v1/search/productLines")
            .await?,
    )?;
    Ok(lines
        .unwrap_or_default()
        .into_iter()
        .map(|l| ProductLine {
            product_line_id: l.product_line_id,
            product_line_name: l.product_line_name,
            product_line_url_name: l.product_line_url_name,
            is_direct: l.is_direct,
        })
        .collect())
}

/// A product line's variants, conditions and languages (`getCategoryFilters`), as answered.
pub async fn filters(catalog: &impl Catalog, category_id: i32) -> Result<Value, String> {
    catalog
        .get(
            Domain::MpSearchApi,
            &format!("/v1/product/categoryfilters?categoryId={category_id}"),
        )
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetName {
    set_name_id: i32,
    category_id: i32,
    name: String,
    clean_set_name: String,
    url_name: String,
    abbreviation: Option<String>,
    release_date: Option<String>,
    #[serde(default)]
    is_supplemental: bool,
    #[serde(default)]
    active: bool,
}

#[derive(Deserialize)]
struct SetNames {
    #[serde(default)]
    results: Option<Vec<SetName>>,
}

/// A product line's sets (`getCatalogSetNames`).
pub async fn set_names(
    catalog: &impl Catalog,
    category_id: i32,
) -> Result<Vec<CategorySet>, String> {
    let names: SetNames = read(
        catalog
            .get(
                Domain::MpApi,
                &format!("/v2/Catalog/SetNames?categoryId={category_id}"),
            )
            .await?,
    )?;
    Ok(names
        .results
        .unwrap_or_default()
        .into_iter()
        .map(|s| CategorySet {
            set_name_id: s.set_name_id,
            category_id: s.category_id,
            name: s.name,
            clean_set_name: s.clean_set_name,
            url_name: s.url_name,
            abbreviation: s.abbreviation,
            release_date: s.release_date,
            is_supplemental: s.is_supplemental,
            active: s.active,
        })
        .collect())
}

/// A product's details and SKUs (`getProductDetails`), as answered.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub product_type_name: Option<String>,
    pub rarity_name: Option<String>,
    pub sealed: Option<bool>,
    pub product_name: Option<String>,
    pub set_id: i32,
    pub set_code: Option<String>,
    pub product_id: i32,
    pub set_name: Option<String>,
    pub product_line_id: i32,
    pub product_status_id: Option<i32>,
    pub product_line_name: Option<String>,
    #[serde(default)]
    pub skus: Vec<Value>,
}

pub async fn details(catalog: &impl Catalog, product_id: i32) -> Result<Details, String> {
    read(
        catalog
            .get(
                Domain::MpSearchApi,
                &format!("/v2/product/{product_id}/details"),
            )
            .await?,
    )
}

/// A product the search found, as a set's product is made from it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub product_id: i32,
    pub product_name: Option<String>,
    pub rarity_name: Option<String>,
    pub set_name: Option<String>,
    pub set_url_name: Option<String>,
    #[serde(default)]
    pub custom_attributes: Option<Attributes>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attributes {
    pub number: Option<String>,
    pub card_type: Option<Vec<String>>,
}

impl Found {
    /// The set product it makes, filed under `set_name_id` in the product line named `game`.
    pub fn filed(&self, set_name_id: i32, game: &str) -> SetProduct {
        let attributes = self.custom_attributes.clone().unwrap_or_default();
        SetProduct {
            set_name_id,
            product_id: self.product_id,
            game: Some(game.to_owned()),
            number: Some(attributes.number.unwrap_or_default()),
            product_name: self.product_name.clone(),
            rarity: self.rarity_name.clone(),
            set_name: self.set_name.clone(),
            set_abbrv: self.set_url_name.clone(),
            kind: Some(
                attributes
                    .card_type
                    .map(|t| t.join(", "))
                    .unwrap_or_default(),
            ),
            display_name: None,
        }
    }
}

/// Each found product once, in the order found, filed under `set_name_id`.
pub fn filed(found: &[Found], set_name_id: i32, game: &str) -> Vec<SetProduct> {
    let mut seen = std::collections::HashSet::new();
    found
        .iter()
        .filter(|f| seen.insert(f.product_id))
        .map(|f| f.filed(set_name_id, game))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    results: Vec<Found>,
    #[serde(default)]
    total_results: usize,
    #[serde(default)]
    aggregations: Option<Aggregations>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Aggregations {
    #[serde(default)]
    set_name: Vec<Bucket>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    url_value: String,
    value: String,
    count: i64,
}

#[derive(Deserialize)]
struct Answer {
    results: Vec<Page>,
}

async fn page(catalog: &impl Catalog, body: &Value) -> Result<Page, String> {
    let answer: Answer = read(catalog.search(body).await?)?;
    answer
        .results
        .into_iter()
        .next()
        .ok_or_else(|| "Cannot read properties of undefined (reading 'totalResults')".to_owned())
}

/// The search API refuses pages larger than this.
const MOST_PER_PAGE: usize = 50;

/// Every product of a set (`getAllProducts` filtered by product line and set, sorted by name),
/// asked `size` at a time.
pub async fn set_products(
    catalog: &impl Catalog,
    product_line: &str,
    set: &str,
    size: usize,
) -> Result<Vec<Found>, String> {
    let size = size.min(MOST_PER_PAGE);
    let mut found = Vec::new();
    let mut from = 0;
    let mut total = 0;
    loop {
        let body = json!({
            "size": size,
            "filters": { "term": { "productLineName": [product_line], "setName": [set] } },
            "sort": { "field": "product-sorting-name", "order": "asc" },
            "from": from,
        });
        let page = page(catalog, &body).await?;
        if from == 0 {
            total = page.total_results;
        }
        if page.results.is_empty() {
            break;
        }
        found.extend(page.results);
        from += size;
        if found.len() >= total {
            break;
        }
    }
    Ok(found)
}

/// A set's product count as the search counts it.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub url_name: String,
    pub name: String,
    pub product_count: i64,
}

/// Every product of a product line counted, in all and by set, with one search
/// (`getSetProductCounts`).
pub async fn set_counts(
    catalog: &impl Catalog,
    product_line_url_name: &str,
) -> Result<(i64, Vec<Listed>), String> {
    let body = json!({
        "from": 0,
        "size": 0,
        "filters": { "term": { "productLineName": [product_line_url_name] } },
    });
    let page = page(catalog, &body).await?;
    let sets = page
        .aggregations
        .map(|a| a.set_name)
        .unwrap_or_default()
        .into_iter()
        .map(|b| Listed {
            url_name: b.url_value,
            name: b.value,
            product_count: b.count,
        })
        .collect();
    Ok((page.total_results as i64, sets))
}
