//! Rows as the Node app's database client (node-pg) hands them over, so a query ported as written
//! answers the same JSON: `int2`/`int4` and floats are numbers, `int8` and `numeric` are
//! strings (node-pg keeps their precision), `json`/`jsonb` are parsed, and `timestamptz` is a
//! `Date`, written as `toISOString` writes it (to the millisecond, truncated, in UTC). A column
//! of any other type is an error naming it: cast it in the query (`::text`).
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx::{Column, Row, TypeInfo, ValueRef, postgres::PgRow};

use crate::features::inventory_economics::ledger::proceeds::iso;

/// One row, keyed by its columns' names, in their order.
pub fn row(row: &PgRow) -> Result<Value, String> {
    let mut object = Map::new();
    for column in row.columns() {
        let i = column.ordinal();
        let value = if row.try_get_raw(i).map_err(|e| e.to_string())?.is_null() {
            Value::Null
        } else {
            cell(row, i, column.type_info().name())?
        };
        object.insert(column.name().to_owned(), value);
    }
    Ok(Value::Object(object))
}

/// Every row, in order.
pub fn rows(rows: &[PgRow]) -> Result<Value, String> {
    rows.iter()
        .map(row)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn cell(row: &PgRow, i: usize, kind: &str) -> Result<Value, String> {
    let failed = |e: sqlx::Error| e.to_string();
    Ok(match kind {
        "INT2" => row.try_get::<i16, _>(i).map_err(failed)?.into(),
        "INT4" => row.try_get::<i32, _>(i).map_err(failed)?.into(),
        "INT8" => row.try_get::<i64, _>(i).map_err(failed)?.to_string().into(),
        "FLOAT4" => f64::from(row.try_get::<f32, _>(i).map_err(failed)?).into(),
        "FLOAT8" => row.try_get::<f64, _>(i).map_err(failed)?.into(),
        "BOOL" => row.try_get::<bool, _>(i).map_err(failed)?.into(),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" => {
            row.try_get::<String, _>(i).map_err(failed)?.into()
        }
        "JSON" | "JSONB" => row.try_get::<Value, _>(i).map_err(failed)?,
        "TIMESTAMPTZ" => iso(row.try_get::<DateTime<Utc>, _>(i).map_err(failed)?).into(),
        "TEXT[]" | "VARCHAR[]" => row.try_get::<Vec<String>, _>(i).map_err(failed)?.into(),
        "INT4[]" => row.try_get::<Vec<i32>, _>(i).map_err(failed)?.into(),
        other => return Err(format!("node_pg: cast the {other} column {i} in the query")),
    })
}
