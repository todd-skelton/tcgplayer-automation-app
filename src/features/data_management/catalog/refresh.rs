//! Reading the catalog from TCGplayer into the local tables (`home.server.ts`): every product line
//! with its filters, a product line's sets, a set's products, and products' details and SKUs.
use futures_util::future::join_all;

use super::{
    source::{self, Catalog},
    store::{self, CategorySet, Product, ProductLine, SetProduct, Sku},
};
use sqlx::PgConnection;

fn failed(e: sqlx::Error) -> String {
    e.to_string()
}

/// Every product line saved, with each one's filters when they can be read
/// (`fetchAllProductLines`).
pub async fn product_lines(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
) -> Result<Vec<ProductLine>, String> {
    let lines = source::product_lines(catalog).await?;
    if lines.is_empty() {
        return Err("No product lines returned from API".to_owned());
    }
    store::save_lines(conn, &lines).await.map_err(failed)?;
    let filters = join_all(
        lines
            .iter()
            .map(|line| source::filters(catalog, line.product_line_id)),
    )
    .await;
    for (line, filters) in lines.iter().zip(filters) {
        let saved = match filters {
            Ok(filters) if !filters.is_null() => {
                store::save_filters(conn, line.product_line_id, &filters)
                    .await
                    .map_err(failed)
            }
            Ok(_) => Ok(()),
            Err(e) => Err(e),
        };
        if let Err(e) = saved {
            tracing::error!(
                "Failed to fetch category filters for product line {}: {e}",
                line.product_line_id
            );
        }
    }
    Ok(lines)
}

/// A product line's sets read again and saved, with the product line
/// (`fetchAndUpsertCategorySets`).
pub async fn sets(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    category_id: i32,
) -> Result<(Vec<CategorySet>, ProductLine), String> {
    let line = store::line(conn, category_id)
        .await
        .map_err(failed)?
        .ok_or_else(|| format!("No product line found for categoryId {category_id}"))?;
    let sets = source::set_names(catalog, category_id).await?;
    if sets.is_empty() {
        return Err(format!(
            "No sets found from getCatalogSetNames for categoryId {category_id}"
        ));
    }
    store::save_sets(conn, &sets).await.map_err(failed)?;
    Ok((sets, line))
}

/// Each set's products as filed, a set with none searched for and saved; a set whose search
/// fails is left out (`fetchAndUpsertSetProducts`).
pub async fn set_products(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    sets: &[CategorySet],
    line: &ProductLine,
) -> Result<Vec<SetProduct>, String> {
    let mut all = Vec::new();
    for set in sets {
        let mut products = store::set_products(conn, set.set_name_id)
            .await
            .map_err(failed)?;
        if products.is_empty() {
            let found = match source::set_products(
                catalog,
                &line.product_line_name,
                &set.clean_set_name,
                24,
            )
            .await
            {
                Ok(found) => found,
                Err(_) => continue,
            };
            products = source::filed(&found, set.set_name_id, &line.product_line_name);
            if store::save_set_products(conn, &products).await.is_err() {
                continue;
            }
        }
        all.extend(products);
    }
    Ok(all)
}

/// What reading products' details and SKUs did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fetched {
    pub product_count: usize,
    pub total_skus: usize,
    pub skus_inserted: usize,
    pub set_changes: usize,
    pub skus_updated: u64,
    pub set_products_updated: usize,
    pub pending_inventory_updated: u64,
}

/// How many products' details are read at once.
const AT_ONCE: usize = 5;

/// The product `details` describe, stored; when they move it to another set than `existing`
/// was in, its SKUs, its filed set product and the inventory counted of it follow.
async fn save(
    conn: &mut PgConnection,
    existing: Option<&Product>,
    details: source::Details,
    product_line_id: i32,
    fetched: &mut Fetched,
) -> Result<Product, String> {
    let product = Product {
        product_type_name: details.product_type_name,
        rarity_name: details.rarity_name,
        sealed: details.sealed,
        product_name: details.product_name,
        set_id: details.set_id,
        set_code: details.set_code,
        product_id: details.product_id,
        set_name: details.set_name,
        product_line_id: details.product_line_id,
        product_status_id: details.product_status_id,
        product_line_name: details.product_line_name,
        skus: sqlx::types::Json(details.skus),
    };
    if let Some(existing) = existing.filter(|e| e.set_id != product.set_id) {
        fetched.set_changes += 1;
        tracing::info!(
            "[fetchAndUpsertProductsAndSkus] SET CHANGE DETECTED for product {}: {:?} ({}) -> {:?} ({})",
            product.product_id,
            existing.set_name,
            existing.set_id,
            product.set_name,
            product.set_id
        );
        let (skus, pending) = store::move_product(conn, &product, product_line_id)
            .await
            .map_err(failed)?;
        fetched.skus_updated += skus;
        let set = store::set(conn, product_line_id, product.set_id)
            .await
            .map_err(failed)?;
        if let Some(filed) = store::set_product(conn, product.product_id)
            .await
            .map_err(failed)?
        {
            let moved = SetProduct {
                set_name_id: product.set_id,
                set_name: product.set_name.clone(),
                set_abbrv: set
                    .and_then(|s| s.abbreviation)
                    .or_else(|| product.set_code.clone()),
                ..filed
            };
            store::save_set_products(conn, &[moved])
                .await
                .map_err(failed)?;
            fetched.set_products_updated += 1;
        }
        fetched.pending_inventory_updated += pending;
    }
    store::save_product(conn, &product).await.map_err(failed)?;
    Ok(product)
}

/// Each product's details and SKUs (`fetchAndUpsertProductsAndSkus`): read from TCGplayer when
/// `force`d or not stored with SKUs, a product that cannot be read skipped; then its SKUs the
/// product line lacks added.
pub async fn products_and_skus(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    product_ids: &[i32],
    product_line_id: i32,
    force: bool,
) -> Result<Fetched, String> {
    let mut fetched = Fetched::default();
    for ids in product_ids.chunks(AT_ONCE) {
        let mut stored = Vec::with_capacity(ids.len());
        for id in ids {
            stored.push(
                store::product(conn, *id, product_line_id)
                    .await
                    .map_err(failed)?,
            );
        }
        let read = join_all(ids.iter().zip(&stored).map(|(id, existing)| async move {
            let stale = force || existing.as_ref().is_none_or(|p| p.skus.0.is_empty());
            if stale {
                Some(source::details(catalog, *id).await)
            } else {
                None
            }
        }))
        .await;
        for ((id, existing), read) in ids.iter().zip(stored).zip(read) {
            let product = match read {
                None => existing,
                Some(details) => {
                    let saved = match details {
                        Ok(details) => {
                            save(
                                conn,
                                existing.as_ref(),
                                details,
                                product_line_id,
                                &mut fetched,
                            )
                            .await
                        }
                        Err(e) => Err(e),
                    };
                    match saved {
                        Ok(product) => Some(product),
                        Err(e) => {
                            tracing::error!(
                                "[fetchAndUpsertProductsAndSkus] Failed to fetch product {id}: {e}"
                            );
                            continue;
                        }
                    }
                }
            };
            let Some(product) = product else { continue };
            fetched.product_count += 1;
            fetched.total_skus += product.skus.0.len();
            let skus: Vec<Sku> = product
                .skus
                .0
                .iter()
                .filter_map(|sku| {
                    let text = |key: &str| sku[key].as_str().map(str::to_owned);
                    Some(Sku {
                        sku: i32::try_from(crate::tcgplayer::whole_value(&sku["sku"])?).ok()?,
                        condition: text("condition"),
                        variant: text("variant"),
                        language: text("language"),
                    })
                })
                .collect();
            let ids: Vec<i32> = skus.iter().map(|s| s.sku).collect();
            let known = store::known_skus(conn, product.product_line_id, &ids)
                .await
                .map_err(failed)?;
            let new: Vec<Sku> = skus
                .into_iter()
                .filter(|s| !known.contains(&s.sku))
                .collect();
            if !new.is_empty() {
                store::add_skus(conn, &product, &new)
                    .await
                    .map_err(failed)?;
                fetched.skus_inserted += new.len();
            }
        }
    }
    Ok(fetched)
}
