//! Saving results priced in the browser (`POST /api/inventory-batches/{batch}/results`), ported
//! from the Node route's action: each priced SKU the browser sent becomes its CSV row
//! (`PricedSkuToTcgPlayerListingConverter`), its result status, and its pricing details as sent,
//! saved over the batch's earlier results (or beside them when only its errors were repriced),
//! and the batch is answered with its counts refreshed. No screen sends this now; an operator's
//! script may. The SKUs are read as JavaScript reads the JSON it was sent, so a value of the wrong
//! kind is refused, or saved, as Node refused or saved it. One difference: a product line sent as
//! a number beside another line is summarized here, where Node's summary threw sorting the lines
//! (`a.localeCompare is not a function`).
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx::{Connection, PgConnection};

use super::batch_json;
use crate::{
    api::{js_string, js_to_number},
    features::{
        batch_pricing::save,
        inventory_economics::ledger::{assumptions::js_to_fixed, fingerprint::js_json},
    },
    node_pg,
};

/// Why the results were not saved: Node's status and `String(error)`.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// A 400 the route answered itself.
    Bad(&'static str),
    /// A 500: what Node threw.
    Thrown(String),
}

fn type_error(message: String) -> Refused {
    Refused::Thrown(format!("TypeError: {message}"))
}

/// Whether JavaScript reads the value as false.
fn falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

fn absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `x || ""`: the value as sent, or empty.
fn or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(v) if !falsy(Some(v)) => v.clone(),
        _ => Value::from(""),
    }
}

/// `x?.toString() || ""`.
fn text(value: Option<&Value>) -> Value {
    match value {
        Some(v) if !absent(Some(v)) => Value::from(js_string(v)),
        _ => Value::from(""),
    }
}

/// `pricedSku.{name}?.toFixed(2) || ""`.
fn fixed(sku: &Map<String, Value>, name: &str) -> Result<Value, Refused> {
    match sku.get(name) {
        None | Some(Value::Null) => Ok(Value::from("")),
        Some(Value::Number(n)) => Ok(Value::from(js_to_fixed(n.as_f64().unwrap_or(0.0), 2))),
        Some(_) => Err(type_error(format!(
            "pricedSku.{name}?.toFixed is not a function"
        ))),
    }
}

/// `pricedSku.{name}?.join("; ") || ""`.
fn joined(sku: &Map<String, Value>, name: &str) -> Result<Value, Refused> {
    match sku.get(name) {
        None | Some(Value::Null) => Ok(Value::from("")),
        Some(Value::Array(items)) => Ok(Value::from(
            items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    item => js_string(item),
                })
                .collect::<Vec<_>>()
                .join("; "),
        )),
        Some(_) => Err(type_error(format!(
            "pricedSku.{name}?.join is not a function"
        ))),
    }
}

/// `pricedSku.sku`'s owner, as reading a property of the element finds it.
fn fields(sku: &Value) -> Result<Map<String, Value>, Refused> {
    match sku {
        Value::Object(fields) => Ok(fields.clone()),
        Value::Null => Err(type_error(
            "Cannot read properties of null (reading 'sku')".into(),
        )),
        _ => Ok(Map::new()),
    }
}

/// `convertFromPricedSkus`: the SKU's row as the CSV export lays it out.
fn row(sku: &Map<String, Value>) -> Result<Value, Refused> {
    let id = match sku.get("sku") {
        None => {
            return Err(type_error(
                "Cannot read properties of undefined (reading 'toString')".into(),
            ));
        }
        Some(Value::Null) => {
            return Err(type_error(
                "Cannot read properties of null (reading 'toString')".into(),
            ));
        }
        Some(id) => js_string(id),
    };
    let quantity = |name: &str| match sku.get(name) {
        Some(v) if !falsy(Some(v)) => js_string(v),
        _ => "0".to_owned(),
    };
    let mut row = Map::new();
    let mut put = |key: &str, value: Value| {
        row.insert(key.to_owned(), value);
    };
    put("TCGplayer Id", Value::from(id));
    put("Product Line", or_empty(sku.get("productLine")));
    put("Set Name", or_empty(sku.get("setName")));
    put("Product", or_empty(sku.get("productName")));
    put("Sku Variant", or_empty(sku.get("variant")));
    put("Sku Condition", or_empty(sku.get("condition")));
    put("Sale Count", text(sku.get("saleCount")));
    put("Lowest Sale Price", fixed(sku, "lowestSalePrice")?);
    put("Highest Sale Price", fixed(sku, "highestSalePrice")?);
    put("TCG Market Price", fixed(sku, "tcgMarketPrice")?);
    put("Total Quantity", Value::from(quantity("quantity")));
    put("Add to Quantity", Value::from(quantity("addToQuantity")));
    put("TCG Marketplace Price", fixed(sku, "price")?);
    put("Previous Price", fixed(sku, "previousPrice")?);
    put("Suggested Price", fixed(sku, "suggestedPrice")?);
    put("Percentile Used", text(sku.get("percentileUsed")));
    let days = text(sku.get("historicalSalesVelocityDays"));
    put("Historical Sales Velocity (Days)", days);
    put(
        "Estimated Time to Sell (Days)",
        text(sku.get("estimatedTimeToSellDays")),
    );
    let sales = text(sku.get("salesCountForHistorical"));
    put("Sales Count for Historical Calculation", sales);
    let listings = text(sku.get("listingsCountForEstimated"));
    put("Listings Count for Estimated Calculation", listings);
    put("Error", joined(sku, "errors")?);
    put("Warning", joined(sku, "warnings")?);
    Ok(Value::Object(row))
}

/// `getPricedSkuResultStatus`: successful when it has a price above zero and no errors.
fn status(sku: &Map<String, Value>) -> &'static str {
    let errors = match sku.get("errors") {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    };
    let priced = sku
        .get("price")
        .filter(|p| !p.is_null())
        .is_some_and(|p| js_to_number(p) > 0.0);
    if priced && !errors {
        "successful"
    } else {
        "manual_review"
    }
}

/// node-pg's text for a parameter (`prepareValue`): an array as Postgres's array literal.
fn pg_text(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let elements: Vec<String> = items
                .iter()
                .map(|item| match item {
                    Value::Null => "NULL".to_owned(),
                    Value::Array(_) => pg_text(item),
                    item => {
                        let text = pg_text(item);
                        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
                    }
                })
                .collect();
            format!("{{{}}}", elements.join(","))
        }
        Value::Object(_) => js_json(value),
        Value::String(text) => text.clone(),
        other => js_string(other),
    }
}

/// `pricedSku.{name} || []` as node-pg sends it.
fn messages(sku: &Map<String, Value>, name: &str) -> String {
    match sku.get(name) {
        Some(v) if !falsy(Some(v)) => pg_text(v),
        _ => "{}".to_owned(),
    }
}

/// The route's action on `conn`: the batch with the results saved, priced at `now`.
pub async fn save_results(
    conn: &mut PgConnection,
    batch_number: i32,
    payload: &Value,
    now: DateTime<Utc>,
) -> Result<Value, Refused> {
    let field = |name: &str| match payload {
        Value::Null => Err(type_error(format!(
            "Cannot read properties of null (reading '{name}')"
        ))),
        Value::Object(fields) => Ok(fields.get(name)),
        _ => Ok(None),
    };
    if field("batchNumber")?.and_then(Value::as_f64) != Some(f64::from(batch_number)) {
        return Err(Refused::Bad("Batch number mismatch"));
    }
    let mode = match field("mode")?.and_then(Value::as_str) {
        Some(mode @ ("full" | "errors")) => mode,
        _ => return Err(Refused::Bad("Invalid pricing mode")),
    };
    let skus = match field("pricedSkus")? {
        Some(Value::Array(skus)) => skus,
        None => {
            return Err(type_error(
                "Cannot read properties of undefined (reading 'map')".into(),
            ));
        }
        Some(Value::Null) => {
            return Err(type_error(
                "Cannot read properties of null (reading 'map')".into(),
            ));
        }
        Some(_) => return Err(type_error("pricedSkus.map is not a function".into())),
    };
    let skus = skus.iter().map(fields).collect::<Result<Vec<_>, _>>()?;
    let rows = skus.iter().map(row).collect::<Result<Vec<_>, _>>()?;
    let thrown = |e: sqlx::Error| Refused::Thrown(node_pg::thrown(e));
    let mut tx = conn.begin().await.map_err(thrown)?;
    if batch_json::find(&mut tx, batch_number)
        .await
        .map_err(Refused::Thrown)?
        .is_none()
    {
        return Err(Refused::Thrown(format!(
            "Error: Batch {batch_number} not found"
        )));
    }
    if mode != "errors" {
        sqlx::query("DELETE FROM inventory_batch_results WHERE batch_number = $1")
            .bind(batch_number)
            .execute(&mut *tx)
            .await
            .map_err(thrown)?;
    }
    for (sku, row) in skus.iter().zip(&rows) {
        let details = sku
            .get("pricingDetails")
            .filter(|d| !falsy(Some(d)))
            .map(js_json);
        sqlx::query(
            "INSERT INTO inventory_batch_results (
                batch_number, sku, result_status, row_json, pricing_details_json,
                error_messages, warning_messages, priced_at
             ) VALUES ($1, $2::text::integer, $3, $4::jsonb, $5::jsonb, $6::text::text[], $7::text::text[], $8)
             ON CONFLICT (batch_number, sku) DO UPDATE SET
                result_status = EXCLUDED.result_status,
                row_json = EXCLUDED.row_json,
                pricing_details_json = EXCLUDED.pricing_details_json,
                error_messages = EXCLUDED.error_messages,
                warning_messages = EXCLUDED.warning_messages,
                priced_at = EXCLUDED.priced_at",
        )
        .bind(batch_number)
        .bind(sku.get("sku").map(pg_text))
        .bind(status(sku))
        .bind(js_json(row))
        .bind(details)
        .bind(messages(sku, "errors"))
        .bind(messages(sku, "warnings"))
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(thrown)?;
    }
    save::refresh_counts(&mut tx, batch_number, now)
        .await
        .map_err(thrown)?;
    let saved = batch_json::find(&mut tx, batch_number)
        .await
        .map_err(Refused::Thrown)?;
    tx.commit().await.map_err(thrown)?;
    Ok(saved.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sku(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn a_sku_is_laid_out_as_the_converter_lays_it_out() {
        let priced = sku(json!({
            "sku": 2231, "productLine": "Pokemon", "productName": "Pikachu", "condition": "",
            "quantity": 0, "addToQuantity": 2, "price": 1.005, "saleCount": 0,
            "percentileUsed": 65, "errors": [], "warnings": ["thin", null, 3],
        }));
        let row = row(&priced).unwrap();
        assert_eq!(row["TCGplayer Id"], "2231");
        assert_eq!(row["Sku Condition"], "");
        assert_eq!(row["Total Quantity"], "0");
        assert_eq!(row["Add to Quantity"], "2");
        assert_eq!(row["TCG Marketplace Price"], "1.00");
        assert_eq!(row["Sale Count"], "0");
        assert_eq!(row["Lowest Sale Price"], "");
        assert_eq!(row["Warning"], "thin; ; 3");
        assert_eq!(status(&priced), "successful");
    }

    #[test]
    fn a_value_of_the_wrong_kind_throws_as_javascript_throws() {
        assert_eq!(
            row(&sku(json!({ "sku": 1, "price": "2" }))).unwrap_err(),
            Refused::Thrown("TypeError: pricedSku.price?.toFixed is not a function".into())
        );
        assert_eq!(
            row(&sku(json!({ "price": 2 }))).unwrap_err(),
            Refused::Thrown(
                "TypeError: Cannot read properties of undefined (reading 'toString')".into()
            )
        );
        assert_eq!(
            status(&sku(json!({ "price": "3", "errors": "" }))),
            "successful"
        );
        assert_eq!(
            status(&sku(json!({ "price": 3, "errors": ["x"] }))),
            "manual_review"
        );
    }

    #[test]
    fn messages_are_sent_as_node_pg_sends_an_array() {
        let warnings = sku(json!({ "warnings": ["a \"b\"", null, 1, "c\\d"] }));
        assert_eq!(
            messages(&warnings, "warnings"),
            r#"{"a \"b\"",NULL,"1","c\\d"}"#
        );
        assert_eq!(messages(&sku(json!({})), "errors"), "{}");
    }
}
