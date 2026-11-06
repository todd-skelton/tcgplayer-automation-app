//! `POST /api/pull-sheet-lookup`: the catalog's SKUs for a pull sheet's rows, keyed by SKU, as the
//! Node route answered them. A row's SKU is looked up under the product line its sheet names (Magic's
//! short name read as the catalog's), so a SKU under another line, or a line the catalog lacks, is not
//! found.
use std::collections::HashMap;

use corten::{Api, JsonResponse, Prefix, extract::Request, http::StatusCode, prelude::*};
use serde_json::{Map, Value, json};

use super::sheet::catalog_product_line;
use crate::{api, app::Shared, database::Database, node_pg};

/// The largest body read: a sheet's rows.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Route)]
#[route("/api/pull-sheet-lookup")]
pub struct PullSheetLookup;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<PullSheetLookup>(
        post(lookup)
            .get(not_allowed)
            .put(not_allowed)
            .patch(not_allowed)
            .delete(not_allowed)
            .with_state(shared.clone()),
    )
}

async fn not_allowed() -> JsonResponse {
    api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
}

/// The SKU ids asked for under each product line the catalog has, in the order asked.
fn by_product_line(items: &[Value], lines: &HashMap<String, i32>) -> Vec<(i32, Vec<i64>)> {
    let mut grouped: Vec<(i32, Vec<i64>)> = Vec::new();
    for item in items {
        let name = item["productLineName"].as_str().unwrap_or_default();
        let Some(&line) = lines.get(&catalog_product_line(name).to_lowercase()) else {
            continue;
        };
        let Some(sku) = item["skuId"].as_f64().filter(|n| n.fract() == 0.0) else {
            continue;
        };
        match grouped.iter_mut().find(|(id, _)| *id == line) {
            Some((_, skus)) => skus.push(sku as i64),
            None => grouped.push((line, vec![sku as i64])),
        }
    }
    grouped
}

async fn lookup(State(db): State<Database>, request: Request) -> JsonResponse {
    let found = async {
        let bytes = crate::api::body_up_to(request.into_body(), MAX_BODY_BYTES)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Error: {e}")))?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("SyntaxError: {e}"),
            )
        })?;
        let items = body["items"]
            .as_array()
            .filter(|items| !items.is_empty())
            .ok_or((
                StatusCode::BAD_REQUEST,
                "items array is required".to_owned(),
            ))?;
        let failed = |e: sqlx::Error| (StatusCode::INTERNAL_SERVER_ERROR, node_pg::thrown(e));
        let lines: Vec<(i32, String)> =
            sqlx::query_as("SELECT product_line_id, product_line_name FROM product_lines")
                .fetch_all(&db.0)
                .await
                .map_err(failed)?;
        let lines: HashMap<String, i32> = lines
            .into_iter()
            .map(|(id, name)| (name.to_lowercase(), id))
            .collect();
        let mut sku_map = Map::new();
        for (line, skus) in by_product_line(items, &lines) {
            let rows = sqlx::query(
                r#"SELECT sku, condition, variant, language,
                    product_type_name AS "productTypeName", rarity_name AS "rarityName", sealed,
                    product_name AS "productName", set_id AS "setId", set_code AS "setCode",
                    product_id AS "productId", set_name AS "setName",
                    product_line_id AS "productLineId", product_status_id AS "productStatusId",
                    product_line_name AS "productLineName"
                FROM skus WHERE product_line_id = $1 AND sku = ANY($2::int[])"#,
            )
            .bind(line)
            .bind(&skus)
            .fetch_all(&db.0)
            .await
            .map_err(failed)?;
            for row in rows {
                let sku = node_pg::row(&row).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
                sku_map.insert(sku["sku"].to_string(), sku);
            }
        }
        Ok::<_, (StatusCode, String)>(json!({ "skuMap": sku_map }))
    };
    match found.await {
        Ok(answer) => api::node_json(&answer),
        Err((status, message)) => api::error(status, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_group_under_the_lines_the_catalog_has() {
        let lines = HashMap::from([
            ("magic: the gathering".to_owned(), 1),
            ("pokemon".to_owned(), 3),
        ]);
        let items = [
            json!({ "skuId": 10, "productLineName": "Magic" }),
            json!({ "skuId": 11, "productLineName": "Pokemon" }),
            json!({ "skuId": 12, "productLineName": " magic " }),
            json!({ "skuId": 13, "productLineName": "Lorcana" }),
        ];
        assert_eq!(
            by_product_line(&items, &lines),
            [(1, vec![10, 12]), (3, vec![11])]
        );
    }
}
