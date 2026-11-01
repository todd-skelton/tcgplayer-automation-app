//! The local catalog's tables, as the Node app's repositories read and write them
//! (`productLinesRepository`, `categoryFiltersRepository`, `categorySetsRepository`,
//! `categorySetSyncsRepository`, `setProductsRepository`, `productsRepository`, `skusRepository`),
//! each on the connection it is given.
use std::collections::{HashMap, HashSet};

use serde_json::Value;
use sqlx::{PgConnection, QueryBuilder};

/// The rows a multi-row write sends at once, as the repositories chunk them.
const CHUNK: usize = 250;

/// A product line as TCGplayer lists it.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct ProductLine {
    pub product_line_id: i32,
    pub product_line_name: String,
    pub product_line_url_name: String,
    pub is_direct: bool,
}

const LINE: &str = "SELECT product_line_id, product_line_name, product_line_url_name, is_direct
    FROM product_lines";

pub async fn line(conn: &mut PgConnection, id: i32) -> sqlx::Result<Option<ProductLine>> {
    sqlx::query_as(&format!("{LINE} WHERE product_line_id = $1"))
        .bind(id)
        .fetch_optional(conn)
        .await
}

pub async fn line_named(
    conn: &mut PgConnection,
    url_name: &str,
) -> sqlx::Result<Option<ProductLine>> {
    sqlx::query_as(&format!("{LINE} WHERE product_line_url_name = $1"))
        .bind(url_name)
        .fetch_optional(conn)
        .await
}

pub async fn save_lines(conn: &mut PgConnection, lines: &[ProductLine]) -> sqlx::Result<()> {
    for chunk in lines.chunks(CHUNK) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO product_lines (product_line_id, product_line_name, product_line_url_name, is_direct) ",
        );
        insert.push_values(chunk, |mut row, line| {
            row.push_bind(line.product_line_id)
                .push_bind(&line.product_line_name)
                .push_bind(&line.product_line_url_name)
                .push_bind(line.is_direct);
        });
        insert.push(
            " ON CONFLICT (product_line_id) DO UPDATE SET
              product_line_name = EXCLUDED.product_line_name,
              product_line_url_name = EXCLUDED.product_line_url_name,
              is_direct = EXCLUDED.is_direct",
        );
        insert.build().execute(&mut *conn).await?;
    }
    Ok(())
}

/// A product line's variants, conditions and languages as TCGplayer's filters name them, stored
/// as they were read.
pub async fn save_filters(
    conn: &mut PgConnection,
    category_id: i32,
    filters: &Value,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO category_filters (category_id, variants, conditions, languages)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (category_id) DO UPDATE SET variants = EXCLUDED.variants,
          conditions = EXCLUDED.conditions, languages = EXCLUDED.languages",
    )
    .bind(category_id)
    .bind(&filters["variants"])
    .bind(&filters["conditions"])
    .bind(&filters["languages"])
    .execute(conn)
    .await?;
    Ok(())
}

/// A set of a product line (`CategorySet`).
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct CategorySet {
    pub set_name_id: i32,
    pub category_id: i32,
    pub name: String,
    pub clean_set_name: String,
    pub url_name: String,
    pub abbreviation: Option<String>,
    pub release_date: Option<String>,
    pub is_supplemental: bool,
    pub active: bool,
}

const SET: &str = "SELECT set_name_id, category_id, name, clean_set_name, url_name, abbreviation,
    release_date, is_supplemental, active FROM category_sets";

pub async fn set(
    conn: &mut PgConnection,
    category_id: i32,
    set_name_id: i32,
) -> sqlx::Result<Option<CategorySet>> {
    sqlx::query_as(&format!(
        "{SET} WHERE category_id = $1 AND set_name_id = $2"
    ))
    .bind(category_id)
    .bind(set_name_id)
    .fetch_optional(conn)
    .await
}

pub async fn set_named(
    conn: &mut PgConnection,
    category_id: i32,
    url_name: &str,
) -> sqlx::Result<Option<CategorySet>> {
    sqlx::query_as(&format!("{SET} WHERE category_id = $1 AND url_name = $2"))
        .bind(category_id)
        .bind(url_name)
        .fetch_optional(conn)
        .await
}

pub async fn save_sets(conn: &mut PgConnection, sets: &[CategorySet]) -> sqlx::Result<()> {
    for chunk in sets.chunks(CHUNK) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO category_sets (set_name_id, category_id, name, clean_set_name, url_name,
              abbreviation, release_date, is_supplemental, active) ",
        );
        insert.push_values(chunk, |mut row, set| {
            row.push_bind(set.set_name_id)
                .push_bind(set.category_id)
                .push_bind(&set.name)
                .push_bind(&set.clean_set_name)
                .push_bind(&set.url_name)
                .push_bind(&set.abbreviation)
                .push_bind(&set.release_date)
                .push_bind(set.is_supplemental)
                .push_bind(set.active);
        });
        insert.push(
            " ON CONFLICT (set_name_id) DO UPDATE SET category_id = EXCLUDED.category_id,
              name = EXCLUDED.name, clean_set_name = EXCLUDED.clean_set_name,
              url_name = EXCLUDED.url_name, abbreviation = EXCLUDED.abbreviation,
              release_date = EXCLUDED.release_date, is_supplemental = EXCLUDED.is_supplemental,
              active = EXCLUDED.active",
        );
        insert.build().execute(&mut *conn).await?;
    }
    Ok(())
}

/// TCGplayer's product count for each of a product line's sets when every listed product was
/// last confirmed stored.
pub async fn verified_counts(
    conn: &mut PgConnection,
    category_id: i32,
) -> sqlx::Result<HashMap<i32, i64>> {
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT syncs.set_name_id, syncs.verified_product_count
        FROM category_set_syncs syncs
        JOIN category_sets sets ON sets.set_name_id = syncs.set_name_id
        WHERE sets.category_id = $1",
    )
    .bind(category_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(set, count)| (set, i64::from(count)))
        .collect())
}

pub async fn record_verified(
    conn: &mut PgConnection,
    set_name_id: i32,
    count: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO category_set_syncs (set_name_id, verified_product_count, verified_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (set_name_id) DO UPDATE SET
          verified_product_count = EXCLUDED.verified_product_count,
          verified_at = EXCLUDED.verified_at",
    )
    .bind(set_name_id)
    .bind(i32::try_from(count).unwrap_or(i32::MAX))
    .execute(conn)
    .await?;
    Ok(())
}

/// A product filed under a set (`SetProduct`).
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct SetProduct {
    pub set_name_id: i32,
    pub product_id: i32,
    pub game: Option<String>,
    pub number: Option<String>,
    pub product_name: Option<String>,
    pub rarity: Option<String>,
    pub set_name: Option<String>,
    pub set_abbrv: Option<String>,
    #[sqlx(rename = "type")]
    pub kind: Option<String>,
    pub display_name: Option<String>,
}

const SET_PRODUCT: &str = "SELECT set_name_id, product_id, game, number, product_name, rarity,
    set_name, set_abbrv, type, display_name FROM set_products";

pub async fn set_products(
    conn: &mut PgConnection,
    set_name_id: i32,
) -> sqlx::Result<Vec<SetProduct>> {
    sqlx::query_as(&format!(
        "{SET_PRODUCT} WHERE set_name_id = $1 ORDER BY product_name ASC"
    ))
    .bind(set_name_id)
    .fetch_all(conn)
    .await
}

pub async fn set_product(
    conn: &mut PgConnection,
    product_id: i32,
) -> sqlx::Result<Option<SetProduct>> {
    sqlx::query_as(&format!("{SET_PRODUCT} WHERE product_id = $1"))
        .bind(product_id)
        .fetch_optional(conn)
        .await
}

/// The set each of `product_ids` is filed under, by product.
pub async fn filed(
    conn: &mut PgConnection,
    product_ids: &[i32],
) -> sqlx::Result<HashMap<i32, i32>> {
    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT product_id, set_name_id FROM set_products WHERE product_id = ANY($1::int[])",
    )
    .bind(product_ids)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Per set of a product line, the products filed under it whose details and SKUs are stored
/// under it too.
pub async fn stored_counts(
    conn: &mut PgConnection,
    category_id: i32,
) -> sqlx::Result<HashMap<i32, i64>> {
    let rows: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT sp.set_name_id, count(*)
        FROM set_products sp
        JOIN category_sets cs ON cs.set_name_id = sp.set_name_id
        JOIN products p ON p.product_id = sp.product_id AND p.set_id = sp.set_name_id
        WHERE cs.category_id = $1 AND jsonb_array_length(p.skus_json) > 0
        GROUP BY sp.set_name_id",
    )
    .bind(category_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

pub async fn save_set_products(
    conn: &mut PgConnection,
    products: &[SetProduct],
) -> sqlx::Result<()> {
    for chunk in products.chunks(CHUNK) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO set_products (set_name_id, product_id, game, number, product_name, rarity,
              set_name, set_abbrv, type, display_name) ",
        );
        insert.push_values(chunk, |mut row, p| {
            row.push_bind(p.set_name_id)
                .push_bind(p.product_id)
                .push_bind(&p.game)
                .push_bind(&p.number)
                .push_bind(&p.product_name)
                .push_bind(&p.rarity)
                .push_bind(&p.set_name)
                .push_bind(&p.set_abbrv)
                .push_bind(&p.kind)
                .push_bind(&p.display_name);
        });
        insert.push(
            " ON CONFLICT (product_id) DO UPDATE SET set_name_id = EXCLUDED.set_name_id,
              game = EXCLUDED.game, number = EXCLUDED.number, product_name = EXCLUDED.product_name,
              rarity = EXCLUDED.rarity, set_name = EXCLUDED.set_name, set_abbrv = EXCLUDED.set_abbrv,
              type = EXCLUDED.type, display_name = EXCLUDED.display_name",
        );
        insert.build().execute(&mut *conn).await?;
    }
    Ok(())
}

/// A product's details and SKUs as stored (`Product`); the SKUs as TCGplayer gave them.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Product {
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
    #[sqlx(rename = "skus_json")]
    pub skus: sqlx::types::Json<Vec<Value>>,
}

pub async fn product(
    conn: &mut PgConnection,
    product_id: i32,
    product_line_id: i32,
) -> sqlx::Result<Option<Product>> {
    sqlx::query_as(
        "SELECT product_type_name, rarity_name, sealed, product_name, set_id, set_code, product_id,
          set_name, product_line_id, product_status_id, product_line_name, skus_json
        FROM products WHERE product_id = $1 AND product_line_id = $2",
    )
    .bind(product_id)
    .bind(product_line_id)
    .fetch_optional(conn)
    .await
}

/// Where each of `product_ids` is stored in the product line: its set, and how many SKUs.
pub async fn placed(
    conn: &mut PgConnection,
    product_ids: &[i32],
    product_line_id: i32,
) -> sqlx::Result<HashMap<i32, (i32, i64)>> {
    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(i32, i32, i32)> = sqlx::query_as(
        "SELECT product_id, set_id, jsonb_array_length(skus_json) FROM products
        WHERE product_line_id = $1 AND product_id = ANY($2::int[])",
    )
    .bind(product_line_id)
    .bind(product_ids)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, set, skus)| (id, (set, i64::from(skus))))
        .collect())
}

pub async fn save_product(conn: &mut PgConnection, p: &Product) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO products (product_type_name, rarity_name, sealed, product_name, set_id,
          set_code, product_id, set_name, product_line_id, product_status_id, product_line_name,
          skus_json, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (product_id) DO UPDATE SET product_type_name = EXCLUDED.product_type_name,
          rarity_name = EXCLUDED.rarity_name, sealed = EXCLUDED.sealed,
          product_name = EXCLUDED.product_name, set_id = EXCLUDED.set_id,
          set_code = EXCLUDED.set_code, set_name = EXCLUDED.set_name,
          product_line_id = EXCLUDED.product_line_id,
          product_status_id = EXCLUDED.product_status_id,
          product_line_name = EXCLUDED.product_line_name, skus_json = EXCLUDED.skus_json,
          updated_at = NOW()",
    )
    .bind(&p.product_type_name)
    .bind(&p.rarity_name)
    .bind(p.sealed)
    .bind(&p.product_name)
    .bind(p.set_id)
    .bind(&p.set_code)
    .bind(p.product_id)
    .bind(&p.set_name)
    .bind(p.product_line_id)
    .bind(p.product_status_id)
    .bind(&p.product_line_name)
    .bind(&p.skus)
    .execute(conn)
    .await?;
    Ok(())
}

/// A SKU with its product's details, as the `skus` table keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct Sku {
    pub sku: i32,
    pub condition: Option<String>,
    pub variant: Option<String>,
    pub language: Option<String>,
}

/// Which of `skus` the product line already has.
pub async fn known_skus(
    conn: &mut PgConnection,
    product_line_id: i32,
    skus: &[i32],
) -> sqlx::Result<HashSet<i32>> {
    if skus.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<i32> = sqlx::query_scalar(
        "SELECT sku FROM skus WHERE product_line_id = $1 AND sku = ANY($2::int[])",
    )
    .bind(product_line_id)
    .bind(skus)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Adds `skus` of `product`; one stored already, in any product line, is left as it is.
pub async fn add_skus(
    conn: &mut PgConnection,
    product: &Product,
    skus: &[Sku],
) -> sqlx::Result<()> {
    for chunk in skus.chunks(CHUNK) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO skus (sku, condition, variant, language, product_type_name, rarity_name,
              sealed, product_name, set_id, set_code, product_id, set_name, product_line_id,
              product_status_id, product_line_name) ",
        );
        insert.push_values(chunk, |mut row, sku| {
            row.push_bind(sku.sku)
                .push_bind(&sku.condition)
                .push_bind(&sku.variant)
                .push_bind(&sku.language)
                .push_bind(&product.product_type_name)
                .push_bind(&product.rarity_name)
                .push_bind(product.sealed)
                .push_bind(&product.product_name)
                .push_bind(product.set_id)
                .push_bind(&product.set_code)
                .push_bind(product.product_id)
                .push_bind(&product.set_name)
                .push_bind(product.product_line_id)
                .push_bind(product.product_status_id)
                .push_bind(&product.product_line_name);
        });
        insert.push(" ON CONFLICT (sku) DO NOTHING");
        insert.build().execute(&mut *conn).await?;
    }
    Ok(())
}

/// Files a product's SKUs, the inventory counted of it and its receipts not yet queued under the
/// set its details now name. How many SKUs and pending counts moved.
pub async fn move_product(
    conn: &mut PgConnection,
    product: &Product,
    product_line_id: i32,
) -> sqlx::Result<(u64, u64)> {
    let skus = sqlx::query(
        "UPDATE skus SET set_id = $1, set_code = $2, set_name = $3
        WHERE product_id = $4 AND product_line_id = $5",
    )
    .bind(product.set_id)
    .bind(&product.set_code)
    .bind(&product.set_name)
    .bind(product.product_id)
    .bind(product_line_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let pending = sqlx::query(
        "UPDATE pending_inventory SET set_id = $1, updated_at = NOW()
        WHERE product_id = $2 AND product_line_id = $3",
    )
    .bind(product.set_id)
    .bind(product.product_id)
    .bind(product_line_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    sqlx::query(
        "UPDATE inventory_receipts receipt SET set_id = $1
        WHERE receipt.product_id = $2 AND receipt.product_line_id = $3
          AND receipt.receipt_kind = 'received'
          AND NOT EXISTS (SELECT 1 FROM inventory_receipt_batch_links link
            WHERE link.receipt_id = receipt.receipt_id)",
    )
    .bind(product.set_id)
    .bind(product.product_id)
    .bind(product_line_id)
    .execute(&mut *conn)
    .await?;
    Ok((skus, pending))
}

/// Removes what is stored of a set: its filed products, their details and their SKUs.
pub async fn remove_set(
    conn: &mut PgConnection,
    set_name_id: i32,
    product_line_id: i32,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM set_products WHERE set_name_id = $1")
        .bind(set_name_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM products WHERE set_id = $1 AND product_line_id = $2")
        .bind(set_name_id)
        .bind(product_line_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM skus WHERE set_id = $1 AND product_line_id = $2")
        .bind(set_name_id)
        .bind(product_line_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
