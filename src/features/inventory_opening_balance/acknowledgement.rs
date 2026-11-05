//! Acknowledging an inventory difference between two observations (`acknowledgeDifference`): the
//! operator explains a change FIFO could not, so it no longer blocks an opening balance. Once per
//! request id; the same request again answers the same difference, and one with another
//! difference, seller or note is refused.
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use crate::{api::js_trim, node_pg};

/// What an acknowledgement asks for, as the body sent it.
pub struct Acknowledgement<'a> {
    pub request_id: &'a str,
    pub difference_id: &'a str,
    pub seller: &'a str,
    pub note: &'a str,
}

fn thrown(message: &str) -> String {
    format!("Error: {message}")
}

/// Acknowledges the difference in a transaction of its own on `conn`: `{id}`, or Node's
/// `String(error)`. The request id is looked up as sent and saved trimmed, as Node did.
pub async fn acknowledge(
    conn: &mut PgConnection,
    input: &Acknowledgement<'_>,
) -> Result<Value, String> {
    let (request_id, note, seller) = (
        js_trim(input.request_id),
        js_trim(input.note),
        js_trim(input.seller),
    );
    if request_id.is_empty() || note.is_empty() {
        return Err(thrown(
            "An acknowledgement request ID and note are required.",
        ));
    }
    let mut tx = conn.begin().await.map_err(node_pg::thrown)?;
    let replay: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id::text, seller_key, acknowledgement_note FROM inventory_observation_differences
         WHERE acknowledgement_request_id = $1 FOR UPDATE",
    )
    .bind(input.request_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(node_pg::thrown)?;
    if let Some((id, saved_seller, saved_note)) = replay {
        if id != input.difference_id
            || saved_seller != seller
            || saved_note.as_deref() != Some(note)
        {
            return Err(thrown(
                "Inventory difference acknowledgement request conflicts.",
            ));
        }
        tx.commit().await.map_err(node_pg::thrown)?;
        return Ok(json!({ "id": id }));
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM inventory_observation_differences
         WHERE id = $1::text::bigint AND seller_key = $2 FOR UPDATE",
    )
    .bind(input.difference_id)
    .bind(seller)
    .fetch_optional(&mut *tx)
    .await
    .map_err(node_pg::thrown)?;
    if existing.is_none() {
        return Err(thrown(
            "Unresolved inventory difference was not found for seller.",
        ));
    }
    let id: Option<String> = sqlx::query_scalar(
        "UPDATE inventory_observation_differences
         SET status = 'acknowledged', acknowledgement_request_id = $2, acknowledgement_note = $3,
           acknowledged_at = NOW()
         WHERE id = $1::text::bigint AND status = 'unresolved' RETURNING id::text",
    )
    .bind(input.difference_id)
    .bind(request_id)
    .bind(note)
    .fetch_optional(&mut *tx)
    .await
    .map_err(node_pg::thrown)?;
    let Some(id) = id else {
        return Err(thrown("Unresolved inventory difference was not found."));
    };
    tx.commit().await.map_err(node_pg::thrown)?;
    Ok(json!({ "id": id }))
}
