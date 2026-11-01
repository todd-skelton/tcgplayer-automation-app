//! The Data Management screen's jobs (`runCatalogMaintenance`), each answered as Node answers it:
//! what it did, or why not, with the status to send.
use sqlx::PgConnection;

use super::{
    refresh,
    source::{self, Catalog},
    store, sync,
};

/// A job and what its form says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// Every product line and its filters read again.
    ProductLines,
    /// The product line's changed sets read again.
    NewProducts { line: i32 },
    /// Every set, product and SKU of the product line checked.
    EveryProduct { line: i32 },
    /// One product and its SKUs read again.
    Product { line: i32, product: i32 },
    /// One set's products and SKUs read, by the set's and product line's address names,
    /// optionally removing what is stored of the set first.
    Set {
        set: String,
        line: String,
        delete_existing: bool,
    },
}

/// What a job answers: what it did, or why it did not, with the status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub outcome: Result<String, String>,
}

fn done(message: String) -> Answer {
    Answer {
        status: 200,
        outcome: Ok(message),
    }
}

fn refused(status: u16, error: impl Into<String>) -> Answer {
    Answer {
        status,
        outcome: Err(error.into()),
    }
}

/// A job that failed as Node writes a thrown error (`String(error)`).
fn thrown(error: String) -> Answer {
    refused(500, format!("Error: {error}"))
}

fn failed(e: sqlx::Error) -> String {
    e.to_string()
}

/// Runs `request` on `conn`, reading TCGplayer through `catalog`.
pub async fn run(conn: &mut PgConnection, catalog: &impl Catalog, request: &Request) -> Answer {
    match request {
        Request::ProductLines => match refresh::product_lines(conn, catalog).await {
            Ok(lines) => done(format!(
                "Fetched and upserted {} product lines and their category filters.",
                lines.len()
            )),
            Err(e) => thrown(e),
        },
        Request::NewProducts { line } => match sync::sync(conn, catalog, *line).await {
            Ok(synced) => done(sync::describe(&synced)),
            Err(e) => thrown(e),
        },
        Request::EveryProduct { line } => match every_product(conn, catalog, *line).await {
            Ok(message) => done(message),
            Err(e) => thrown(e),
        },
        Request::Product { line, product } => {
            match product_and_skus(conn, catalog, *line, *product).await {
                Ok(answer) => answer,
                Err(e) => thrown(e),
            }
        }
        Request::Set {
            set,
            line,
            delete_existing,
        } => match set_products(conn, catalog, set, line, *delete_existing).await {
            Ok(answer) => answer,
            Err(e) => thrown(e),
        },
    }
}

async fn every_product(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    category_id: i32,
) -> Result<String, String> {
    let (sets, line) = refresh::sets(conn, catalog, category_id).await?;
    let products = refresh::set_products(conn, catalog, &sets, &line).await?;
    let ids: Vec<i32> = products.iter().map(|p| p.product_id).collect();
    let fetched =
        refresh::products_and_skus(conn, catalog, &ids, line.product_line_id, false).await?;
    Ok(format!(
        "Fetched and verified all sets, products, and skus for category {category_id} using PostgreSQL. Sets: {}, set-products: {}, products: {}, skus: {}.",
        sets.len(),
        products.len(),
        fetched.product_count,
        fetched.total_skus
    ))
}

async fn product_and_skus(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    line: i32,
    product: i32,
) -> Result<Answer, String> {
    if product <= 0 {
        return Ok(refused(400, "Missing or invalid productId"));
    }
    if line <= 0 {
        return Ok(refused(
            400,
            "Product Line ID is required for optimized performance",
        ));
    }
    let Some(existing) = store::product(conn, product, line).await.map_err(failed)? else {
        return Ok(refused(
            404,
            format!("Product with ID {product} not found in product line {line}"),
        ));
    };
    let fetched =
        refresh::products_and_skus(conn, catalog, &[product], existing.product_line_id, true)
            .await?;
    let mut message = format!(
        "Updated product and skus for productId {product}. Products: {}, skus: {}.",
        fetched.product_count, fetched.total_skus
    );
    if fetched.set_changes > 0 {
        message.push_str(&format!(
            " Set reclassification detected and corrected: {} SKUs updated, {} SetProducts updated, {} PendingInventory entries updated.",
            fetched.skus_updated, fetched.set_products_updated, fetched.pending_inventory_updated
        ));
    }
    Ok(done(message))
}

async fn set_products(
    conn: &mut PgConnection,
    catalog: &impl Catalog,
    set_name: &str,
    line_name: &str,
    delete_existing: bool,
) -> Result<Answer, String> {
    if set_name.is_empty() {
        return Ok(refused(400, "Missing set name"));
    }
    if line_name.is_empty() {
        return Ok(refused(400, "Missing product line name"));
    }
    let not_found = || refused(400, format!("Product line not found: {line_name}"));
    if delete_existing {
        let Some(line) = store::line_named(conn, line_name).await.map_err(failed)? else {
            return Ok(not_found());
        };
        if let Some(set) = store::set_named(conn, line.product_line_id, set_name)
            .await
            .map_err(failed)?
        {
            store::remove_set(conn, set.set_name_id, line.product_line_id)
                .await
                .map_err(failed)?;
        }
    }
    let Some(line) = store::line_named(conn, line_name).await.map_err(failed)? else {
        return Ok(not_found());
    };
    let mut set = store::set_named(conn, line.product_line_id, set_name)
        .await
        .map_err(failed)?;
    if set.is_none() {
        match refresh::sets(conn, catalog, line.product_line_id).await {
            Ok(_) => {
                set = store::set_named(conn, line.product_line_id, set_name)
                    .await
                    .map_err(failed)?;
            }
            Err(e) => eprintln!(
                "Could not fetch sets for category {}: {e}",
                line.product_line_id
            ),
        }
    }
    let set_name_id = set.map_or(0, |s| s.set_name_id);
    let found = match source::set_products(catalog, line_name, set_name, 1000).await {
        Ok(found) => found,
        Err(e) => {
            return Ok(refused(
                500,
                format!("Failed to search for products: Error: {e}"),
            ));
        }
    };
    if found.is_empty() {
        return Ok(refused(
            404,
            format!(
                "No products found for set \"{set_name}\" in product line \"{line_name}\". Please check the set name and product line."
            ),
        ));
    }
    let products = source::filed(&found, set_name_id, line_name);
    if let Err(e) = store::save_set_products(conn, &products).await {
        return Ok(refused(
            500,
            format!("Failed to search for products: Error: {e}"),
        ));
    }
    let ids: Vec<i32> = products.iter().map(|p| p.product_id).collect();
    let fetched =
        refresh::products_and_skus(conn, catalog, &ids, line.product_line_id, false).await?;
    Ok(done(format!(
        "Fetched and verified products and SKUs for set \"{set_name}\" in product line \"{line_name}\". Set products: {}, products: {}, SKUs: {}.",
        products.len(),
        fetched.product_count,
        fetched.total_skus
    )))
}
