//! The inventory counted and not yet queued (`pending_inventory`), and its changes, ported from
//! `pendingInventoryRepository.mutate`: each change is applied once by its request id, under the
//! lock Node takes too, and a set is refused when the count moved meanwhile. A set that raises a
//! count notes the card's market price at intake, a live TCGplayer read, so it still goes through
//! the Node app's `/api/pending-inventory`.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection};

use crate::{
    database::Database, features::batch_pricing::imported::refused as failed, legacy::Legacy,
};

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

/// Where a SKU belongs, which is stored with its count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub product_line_id: i32,
    pub set_id: i32,
    pub product_id: i32,
}

/// A change to the counts made here.
#[derive(Clone, Copy, Debug)]
pub enum Change {
    /// A SKU's count set to `quantity`, at most `seen`, the count the user saw.
    Set {
        sku: i32,
        place: Place,
        quantity: i32,
        seen: i32,
    },
    /// Every count removed.
    Clear,
}

impl Change {
    fn kind(self) -> &'static str {
        match self {
            Change::Set { .. } => "set",
            Change::Clear => "clear",
        }
    }
}

/// What a change left: the SKU's count after it (none after a clear), how far it moved, and
/// whether its request was applied before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    pub quantity: i32,
    pub delta: i32,
    pub repeated: bool,
}

/// A change already applied under a request id.
#[derive(sqlx::FromRow)]
struct Stored {
    mutation_type: String,
    sku: Option<i32>,
    requested_quantity: Option<i32>,
    expected_quantity: Option<i32>,
    product_line_id: Option<i32>,
    set_id: Option<i32>,
    product_id: Option<i32>,
    quantity_delta: i32,
    resulting_quantity: i32,
}

impl Stored {
    /// Whether it is `change`: the same request again, not another one under its id.
    fn is(&self, change: Change) -> bool {
        let (sku, requested, expected, place) = match change {
            Change::Set {
                sku,
                place,
                quantity,
                seen,
            } => (Some(sku), Some(quantity), Some(seen), Some(place)),
            Change::Clear => (None, None, None, None),
        };
        self.mutation_type == change.kind()
            && self.sku == sku
            && self.requested_quantity == requested
            && self.expected_quantity == expected
            && self.product_line_id == place.map(|p| p.product_line_id)
            && self.set_id == place.map(|p| p.set_id)
            && self.product_id == place.map(|p| p.product_id)
    }
}

/// The receipts a pending count is made of, with what is left of each after its adjustments and
/// the batches it was queued in, newest first: a count lowered takes from the newest.
const BALANCES: &str = r#"WITH adjusted_receipts AS (
  SELECT receipt.receipt_id, receipt.sku, receipt.intake_at, receipt.recorded_at,
    receipt.original_quantity + COALESCE(SUM(adjustment.quantity_delta), 0)::integer AS adjusted_quantity
  FROM inventory_receipts receipt
  JOIN pending_inventory pending ON pending.sku = receipt.sku
  LEFT JOIN inventory_receipt_adjustments adjustment ON adjustment.receipt_id = receipt.receipt_id
  WHERE receipt.receipt_kind = 'received'
    AND NOT EXISTS (SELECT 1 FROM inventory_receipt_batch_links linked
      WHERE linked.receipt_id = receipt.receipt_id)
  GROUP BY receipt.receipt_id
), receipt_balances AS (
  SELECT receipt.receipt_id, receipt.sku, receipt.intake_at, receipt.recorded_at,
    receipt.adjusted_quantity - COALESCE(SUM(link.linked_quantity), 0)::integer AS quantity
  FROM adjusted_receipts receipt
  LEFT JOIN inventory_receipt_batch_links link ON link.receipt_id = receipt.receipt_id
  GROUP BY receipt.receipt_id, receipt.sku, receipt.intake_at, receipt.recorded_at,
    receipt.adjusted_quantity
)
SELECT receipt_id, quantity FROM receipt_balances
WHERE quantity > 0 AND ($1::int IS NULL OR sku = $1)
ORDER BY intake_at DESC NULLS LAST, recorded_at DESC, receipt_id DESC"#;

/// What to take from each receipt, newest first, to remove `quantity` (`reducePendingReceipts`).
fn reduce(receipts: &[(i32, i32)], quantity: i32) -> Result<Vec<(i32, i32)>, String> {
    let available: i64 = receipts.iter().map(|(_, q)| i64::from(*q)).sum();
    if i64::from(quantity) > available {
        return Err("Cannot remove more than the pending quantity".to_owned());
    }
    let mut remaining = quantity;
    let mut taken = Vec::new();
    for &(receipt, left) in receipts {
        if remaining == 0 {
            break;
        }
        let removed = left.min(remaining);
        if removed > 0 {
            taken.push((receipt, -removed));
            remaining -= removed;
        }
    }
    Ok(taken)
}

/// Takes `quantity` from the newest pending receipts, of `sku` or of every SKU.
async fn remove(
    conn: &mut PgConnection,
    request_id: &str,
    quantity: i32,
    reason: &str,
    sku: Option<i32>,
) -> Result<(), String> {
    let receipts: Vec<(i32, i32)> = sqlx::query_as(BALANCES)
        .bind(sku)
        .fetch_all(&mut *conn)
        .await
        .map_err(failed)?;
    let (ids, deltas): (Vec<i32>, Vec<i32>) = reduce(&receipts, quantity)?.into_iter().unzip();
    sqlx::query(
        "INSERT INTO inventory_receipt_adjustments (receipt_id, mutation_request_id, quantity_delta, reason)
        SELECT receipt, $2, delta, $3 FROM UNNEST($1::int[], $4::int[]) WITH ORDINALITY AS a(receipt, delta, n)
        ORDER BY n",
    )
    .bind(&ids)
    .bind(request_id)
    .bind(reason)
    .bind(&deltas)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    Ok(())
}

async fn record(
    conn: &mut PgConnection,
    request_id: &str,
    change: Change,
    delta: i32,
    resulting: i32,
) -> Result<(), String> {
    let (sku, requested, expected, place) = match change {
        Change::Set {
            sku,
            place,
            quantity,
            seen,
        } => (Some(sku), Some(quantity), Some(seen), Some(place)),
        Change::Clear => (None, None, None, None),
    };
    sqlx::query(
        "INSERT INTO inventory_pending_mutations (request_id, mutation_type, sku, requested_quantity,
          expected_quantity, product_line_id, set_id, product_id, quantity_delta, resulting_quantity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(request_id)
    .bind(change.kind())
    .bind(sku)
    .bind(requested)
    .bind(expected)
    .bind(place.map(|p| p.product_line_id))
    .bind(place.map(|p| p.set_id))
    .bind(place.map(|p| p.product_id))
    .bind(delta)
    .bind(resulting)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    Ok(())
}

/// Applies `change` once per `request_id`, in a transaction of its own on `conn` (a savepoint
/// when `conn` is in one). The same request again answers what it did; another one under its id,
/// a count that moved since it was seen, or a SKU stored with another place is refused.
pub async fn apply(
    conn: &mut PgConnection,
    request_id: &str,
    change: Change,
) -> Result<Applied, String> {
    let mut tx = conn.begin().await.map_err(failed)?;
    let applied = applied(&mut tx, request_id, change).await?;
    tx.commit().await.map_err(failed)?;
    Ok(applied)
}

async fn applied(
    conn: &mut PgConnection,
    request_id: &str,
    change: Change,
) -> Result<Applied, String> {
    sqlx::query("SELECT pg_advisory_xact_lock(55, 0)")
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    let stored: Option<Stored> = sqlx::query_as(
        "SELECT mutation_type, sku, requested_quantity, expected_quantity, product_line_id, set_id,
          product_id, quantity_delta, resulting_quantity
        FROM inventory_pending_mutations WHERE request_id = $1",
    )
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    if let Some(stored) = stored {
        if !stored.is(change) {
            return Err(format!(
                "Request ID {request_id} was already used for a different inventory mutation"
            ));
        }
        return Ok(Applied {
            quantity: stored.resulting_quantity,
            delta: stored.quantity_delta,
            repeated: true,
        });
    }
    let Change::Set {
        sku,
        place,
        quantity,
        seen,
    } = change
    else {
        let total: i32 =
            sqlx::query_scalar("SELECT COALESCE(SUM(quantity), 0)::int FROM pending_inventory")
                .fetch_one(&mut *conn)
                .await
                .map_err(failed)?;
        record(conn, request_id, change, -total, 0).await?;
        if total > 0 {
            remove(conn, request_id, total, "clear", None).await?;
        }
        sqlx::query("DELETE FROM pending_inventory")
            .execute(&mut *conn)
            .await
            .map_err(failed)?;
        return Ok(Applied {
            quantity: 0,
            delta: -total,
            repeated: false,
        });
    };
    let existing: Option<(i32, i32, i32, i32)> = sqlx::query_as(
        "SELECT quantity, product_line_id, set_id, product_id FROM pending_inventory WHERE sku = $1",
    )
    .bind(sku)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    if let Some((_, product_line_id, set_id, product_id)) = existing
        && place
            != (Place {
                product_line_id,
                set_id,
                product_id,
            })
    {
        return Err(format!(
            "SKU {sku} already has different pending product metadata"
        ));
    }
    let current = existing.map_or(0, |(quantity, ..)| quantity);
    if current != seen {
        return Err(format!(
            "Pending quantity changed from {seen} to {current}; reload before replacing it"
        ));
    }
    let delta = quantity - current;
    if delta > 0 {
        return Err(
            "A raised count is recorded by the Node app, which reads its market price.".to_owned(),
        );
    }
    record(conn, request_id, change, delta, quantity).await?;
    if delta < 0 {
        remove(conn, request_id, -delta, "correction", Some(sku)).await?;
    }
    let row = if quantity == 0 {
        sqlx::query("DELETE FROM pending_inventory WHERE sku = $1").bind(sku)
    } else {
        sqlx::query("UPDATE pending_inventory SET quantity = $2, updated_at = NOW() WHERE sku = $1")
            .bind(sku)
            .bind(quantity)
    };
    row.execute(&mut *conn).await.map_err(failed)?;
    Ok(Applied {
        quantity,
        delta,
        repeated: false,
    })
}

/// A raised count as the Node route reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Raise<'a> {
    operation: &'static str,
    request_id: &'a str,
    sku: i32,
    quantity: u32,
    expected_quantity: u32,
    #[serde(flatten)]
    place: Place,
}

#[derive(Deserialize)]
struct Raised {
    quantity: i32,
}

fn whole(count: u32) -> Result<i32, String> {
    i32::try_from(count).map_err(|_| format!("A count of {count} is too large."))
}

/// Sets a SKU's count once per `request_id`, and gives the count after it. `seen` is the count
/// the user saw, so a count changed meanwhile is refused. A raised count goes through the Node
/// app, which notes the market price.
pub async fn set(
    db: &Database,
    legacy: &Legacy,
    request_id: &str,
    sku: i32,
    place: Place,
    quantity: u32,
    seen: u32,
) -> Result<i32, String> {
    if quantity > seen {
        let raise = Raise {
            operation: "set",
            request_id,
            sku,
            quantity,
            expected_quantity: seen,
            place,
        };
        let raised: Raised = legacy.send("/api/pending-inventory", &raise).await?;
        return Ok(raised.quantity);
    }
    let change = Change::Set {
        sku,
        place,
        quantity: whole(quantity)?,
        seen: whole(seen)?,
    };
    let mut conn = db.0.acquire().await.map_err(failed)?;
    apply(&mut conn, request_id, change)
        .await
        .map(|applied| applied.quantity)
}

/// Removes every count not yet queued, once per `request_id`.
pub async fn clear(db: &Database, request_id: &str) -> Result<(), String> {
    let mut conn = db.0.acquire().await.map_err(failed)?;
    apply(&mut conn, request_id, Change::Clear).await.map(drop)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn a_raise_is_the_json_the_node_route_reads() {
        let raise = Raise {
            operation: "set",
            request_id: "r1",
            sku: 7,
            quantity: 2,
            expected_quantity: 1,
            place: Place {
                product_line_id: 3,
                set_id: 24831,
                product_id: 10,
            },
        };
        assert_eq!(
            serde_json::to_value(&raise).unwrap(),
            json!({"operation": "set", "requestId": "r1", "sku": 7, "quantity": 2,
                "expectedQuantity": 1, "productLineId": 3, "setId": 24831, "productId": 10})
        );
    }

    #[test]
    fn a_removal_takes_from_the_newest_receipts() {
        assert_eq!(
            reduce(&[(9, 1), (8, 3), (7, 2)], 3),
            Ok(vec![(9, -1), (8, -2)])
        );
        assert_eq!(
            reduce(&[(9, 1), (8, 0), (7, 2)], 3),
            Ok(vec![(9, -1), (7, -2)])
        );
        assert_eq!(reduce(&[(9, 1)], 0), Ok(vec![]));
        assert_eq!(
            reduce(&[(9, 1)], 2),
            Err("Cannot remove more than the pending quantity".to_owned())
        );
    }

    /// The steps in `.port-logs/pending-steps.json` from the counts `pending-seed.sql` makes, on the
    /// dev database in a transaction rolled back, against Node's `pendingInventoryRepository.mutate`
    /// over the same (`.port-logs/pending-node.ts`): each answer or refusal, and what is left.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's run in .port-logs"]
    async fn changes_apply_as_node_applies_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Value = serde_json::from_str(&read("pending.node.json")).unwrap();
        let steps: Vec<Value> = serde_json::from_str(&read("pending-steps.json")).unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read("pending-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut answers = Vec::new();
        for step in &steps {
            let number = |key: &str| i32::try_from(step[key].as_i64().unwrap()).unwrap();
            let change = if step["type"] == "clear" {
                Change::Clear
            } else {
                let place = |i: usize| i32::try_from(step["place"][i].as_i64().unwrap()).unwrap();
                Change::Set {
                    sku: number("sku"),
                    place: Place {
                        product_line_id: place(0),
                        set_id: place(1),
                        product_id: place(2),
                    },
                    quantity: number("quantity"),
                    seen: number("expected"),
                }
            };
            answers.push(
                match apply(&mut tx, step["request"].as_str().unwrap(), change).await {
                    Ok(a) => json!({"quantity": a.quantity, "quantityDelta": a.delta,
                        "repeated": a.repeated}),
                    Err(error) => json!({ "error": error }),
                },
            );
        }
        let captured: String = sqlx::query_scalar(&read("pending-capture.sql"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(Value::Array(answers), node["answers"]);
        assert_eq!(
            serde_json::from_str::<Value>(&captured).unwrap(),
            node["captured"]
        );
    }

    #[test]
    fn totals_count_units_and_skus() {
        let quantities = HashMap::from([(1, 2), (5, 3)]);
        assert_eq!(Totals::of(&quantities), Totals { units: 5, skus: 2 });
    }
}
