//! The inventory counted and not yet queued (`pending_inventory`). This reads it; a change goes
//! through the Node app's `/api/pending-inventory`, whose rules (each change applied once by its
//! request id, a set refused when the count moved meanwhile, the market price noted when units
//! are added) stay there until the intake workers move here.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{database::Database, legacy::Legacy};

/// How many units of each SKU are counted.
pub async fn quantities(db: &Database) -> sqlx::Result<HashMap<i32, i32>> {
    let rows: Vec<(i32, i32)> = sqlx::query_as("SELECT sku, quantity FROM pending_inventory")
        .fetch_all(&db.0)
        .await?;
    Ok(rows.into_iter().collect())
}

/// The units and SKUs counted, for the queue bar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub units: i64,
    pub skus: i64,
}

impl Totals {
    pub fn of(quantities: &HashMap<i32, i32>) -> Self {
        Totals {
            units: quantities.values().map(|q| i64::from(*q)).sum(),
            skus: quantities.len() as i64,
        }
    }
}

/// Where a SKU belongs, which the Node app stores with its count.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub product_line_id: i32,
    pub set_id: i32,
    pub product_id: i32,
}

/// A change to one SKU's count, or to all of them.
#[derive(Clone, Copy, Debug)]
pub enum Change {
    Add(u32),
    Remove(u32),
    /// The count to set, and the count the user saw, so a count changed meanwhile is refused.
    Set {
        quantity: u32,
        seen: u32,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mutation<'a> {
    operation: &'static str,
    request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sku: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_quantity: Option<u32>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    place: Option<Place>,
}

#[derive(Deserialize)]
struct Applied {
    quantity: i32,
}

/// Applies a change to a SKU's count once per `request_id`, and gives the count after it.
pub async fn change(
    legacy: &Legacy,
    request_id: &str,
    sku: i32,
    place: Place,
    change: Change,
) -> Result<i32, String> {
    let (operation, quantity, expected_quantity) = match change {
        Change::Add(n) => ("add", n, None),
        Change::Remove(n) => ("remove", n, None),
        Change::Set { quantity, seen } => ("set", quantity, Some(seen)),
    };
    let mutation = Mutation {
        operation,
        request_id,
        sku: Some(sku),
        quantity: Some(quantity),
        expected_quantity,
        place: Some(place),
    };
    let applied: Applied = legacy.send("/api/pending-inventory", &mutation).await?;
    Ok(applied.quantity)
}

/// Removes every count not yet queued, once per `request_id`.
pub async fn clear(legacy: &Legacy, request_id: &str) -> Result<(), String> {
    let mutation = Mutation {
        operation: "clear",
        request_id,
        sku: None,
        quantity: None,
        expected_quantity: None,
        place: None,
    };
    let _: serde_json::Value = legacy.send("/api/pending-inventory", &mutation).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_is_the_json_the_node_route_reads() {
        let place = Place {
            product_line_id: 3,
            set_id: 24831,
            product_id: 10,
        };
        let set = Mutation {
            operation: "set",
            request_id: "r1",
            sku: Some(7),
            quantity: Some(2),
            expected_quantity: Some(1),
            place: Some(place),
        };
        assert_eq!(
            serde_json::to_value(&set).unwrap(),
            serde_json::json!({"operation": "set", "requestId": "r1", "sku": 7, "quantity": 2,
                "expectedQuantity": 1, "productLineId": 3, "setId": 24831, "productId": 10})
        );
        let clear = Mutation {
            operation: "clear",
            request_id: "r2",
            sku: None,
            quantity: None,
            expected_quantity: None,
            place: None,
        };
        assert_eq!(
            serde_json::to_value(&clear).unwrap(),
            serde_json::json!({"operation": "clear", "requestId": "r2"})
        );
    }

    #[test]
    fn totals_count_units_and_skus() {
        let quantities = HashMap::from([(1, 2), (5, 3)]);
        assert_eq!(Totals::of(&quantities), Totals { units: 5, skus: 2 });
    }
}
