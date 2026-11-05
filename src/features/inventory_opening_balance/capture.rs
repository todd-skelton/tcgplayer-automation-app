//! Capturing a complete observation of the seller's inventory, ported from
//! `captureInventoryObservation.server.ts` and the repository's `beginObservationCapture`,
//! `recordObservation` and `failObservationCapture`. The request is claimed before Seller Portal
//! is read, so a completed request answers its observation again without reading it, and an
//! expired or failed one may be retried without its former owner overwriting the new attempt.
//! The pricing page is read before and after two exports, each must name the seller, and the
//! observation is `complete` when both exports hold the same quantities, `unstable` otherwise.
//!
//! Failures are Node's `String(error)`: `Error: ...` for its own, `error: ...` for the
//! database's, `AxiosError: ...` for a refused Seller Portal request.
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use super::observation::{self, Item};
use crate::{
    csv_text,
    features::{http_configuration::config::Domain, inventory_fifo::queue},
    node_pg,
    tcgplayer::{Call, Failure, TcgPlayer},
};

/// The longest a capture may read Seller Portal for.
const DEADLINE: Duration = Duration::from_secs(150);

/// Where an observation is read: Seller Portal's pricing page and its live export.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Portal {
    /// The pricing page, which declares the signed-in seller.
    async fn pricing_context(&self) -> Result<String, String>;
    /// The **Export From Live** CSV.
    async fn export(&self) -> Result<String, String>;
}

/// Seller Portal itself, each read once (never retried) within 30 seconds.
pub struct SellerPortal<'a>(pub &'a TcgPlayer);

impl SellerPortal<'_> {
    async fn text(&self, path: &str) -> Result<String, String> {
        let call = Call {
            retry: false,
            timeout: Duration::from_secs(30),
        };
        match self.0.get_bytes(Domain::SellerPortal, path, call).await {
            // As axios reads text: UTF-8, its byte order mark dropped.
            Ok(bytes) => Ok(csv_text::decode(&bytes)),
            Err(failure @ Failure::Status(_)) => Err(format!("AxiosError: {failure}")),
            Err(failure) => Err(format!("Error: {failure}")),
        }
    }
}

impl Portal for SellerPortal<'_> {
    async fn pricing_context(&self) -> Result<String, String> {
        self.text("/admin/pricing").await
    }

    async fn export(&self) -> Result<String, String> {
        self.text("/Admin/Pricing/DownloadMyExportCSV?type=Pricing")
            .await
    }
}

/// `String(error)` of an `Error` Node threw.
pub(super) fn thrown(message: &str) -> String {
    format!("Error: {message}")
}

/// Now, to the millisecond, as a JavaScript `Date` holds it.
pub(super) fn now_ms() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).expect("now is in range")
}

/// What a capture is asked for: its request, the seller, and what it is for (an opening
/// observation unless said otherwise).
pub struct Capture<'a> {
    pub request_id: &'a str,
    pub seller: &'a str,
    pub purpose: Option<Value>,
}

/// What claiming a request found.
enum Claim {
    /// The request already completed: its observation.
    Complete(Value),
    /// This attempt owns the request.
    Claimed(String),
}

/// `captureInventoryObservation`: the observation `input` asks for, read from `portal` and
/// recorded on `conn`, or the one it already recorded.
pub async fn capture(
    conn: &mut PgConnection,
    portal: &impl Portal,
    input: &Capture<'_>,
    now: &(dyn Fn() -> DateTime<Utc> + Sync),
) -> Result<Value, String> {
    let seller = crate::js_number::trim(input.seller);
    let request_id = crate::js_number::trim(input.request_id);
    if request_id.is_empty() || seller.is_empty() {
        return Err(thrown("Request ID and seller key are required."));
    }
    let purpose = input
        .purpose
        .clone()
        .unwrap_or_else(|| json!({ "kind": "opening_observation" }));
    let token = match begin(conn, request_id, seller, &purpose).await? {
        Claim::Complete(observation) => return Ok(observation),
        Claim::Claimed(token) => token,
    };
    let attempt = async {
        let started_at = now();
        let before = portal.pricing_context().await?;
        let before_count =
            observation::validate_context(&before, seller).map_err(|e| thrown(&e))?;
        let first_csv = portal.export().await?;
        let first = observation::parse_export(&first_csv).map_err(|e| thrown(&e))?;
        let second_csv = portal.export().await?;
        let second = observation::parse_export(&second_csv).map_err(|e| thrown(&e))?;
        let after = portal.pricing_context().await?;
        let after_count = observation::validate_context(&after, seller).map_err(|e| thrown(&e))?;
        let stable =
            observation::quantity_fingerprint(&first) == observation::quantity_fingerprint(&second);
        Ok::<_, String>(Observed {
            before_count,
            after_count,
            stable,
            started_at,
            first_content: observation::content_fingerprint(&first_csv),
            second_content: observation::content_fingerprint(&second_csv),
            items: second,
        })
    };
    let read = match tokio::time::timeout(DEADLINE, attempt).await {
        Ok(read) => read,
        Err(_) => Err("CanceledError: canceled".to_owned()),
    };
    let recorded = match read {
        Ok(observed) => {
            let cutoff_at = now();
            record(conn, request_id, seller, &token, &observed, cutoff_at).await
        }
        Err(error) => Err(error),
    };
    match recorded {
        Ok(observation) => Ok(observation),
        Err(error) => {
            fail(conn, request_id, &token, &error).await?;
            Err(error)
        }
    }
}

/// What a capture read from Seller Portal.
struct Observed {
    before_count: usize,
    after_count: usize,
    stable: bool,
    started_at: DateTime<Utc>,
    first_content: String,
    second_content: String,
    /// The second export's items.
    items: Vec<Item>,
}

/// A completed observation as `beginObservationCapture` reads it back.
const COMPLETED: &str = r#"SELECT id::text AS id,seller_key AS "sellerKey",status,
            quantity_fingerprint AS "quantityFingerprint",supported_quantity_fingerprint AS "supportedQuantityFingerprint",
            item_count AS "itemCount",positive_item_count AS "positiveItemCount",total_quantity AS "observedTotalQuantity",
            supported_positive_sku_count AS "positiveSkuCount",supported_total_quantity AS "totalQuantity",
            unsupported_positive_item_count AS "unsupportedPositiveItemCount",
            unsupported_positive_quantity AS "unsupportedPositiveQuantity",
            cutoff_at AS "cutoffAt"
           FROM inventory_complete_observations WHERE id=$1::bigint"#;

/// A request already made: its seller, status, claim's expiry, observation, and whether it was
/// for the same purpose.
type Request = (
    String,
    String,
    Option<DateTime<Utc>>,
    Option<String>,
    Option<bool>,
);

/// `beginObservationCapture`: the request's completed observation, or a claim on it for three
/// minutes.
async fn begin(
    conn: &mut PgConnection,
    request_id: &str,
    seller: &str,
    purpose: &Value,
) -> Result<Claim, String> {
    let failed = node_pg::thrown;
    let mut tx = conn.begin().await.map_err(failed)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("opening-capture:{request_id}"))
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    let existing: Option<Request> = sqlx::query_as(
        "SELECT seller_key,status,claim_expires_at,observation_id::text,purpose_evidence=$2::jsonb
             FROM inventory_complete_observation_requests WHERE request_id=$1 FOR UPDATE",
    )
    .bind(request_id)
    .bind(purpose.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if let Some((existing_seller, status, expires, observation_id, purpose_matches)) = &existing {
        if existing_seller != seller {
            return Err(thrown(
                "Observation request ID was reused for a different seller.",
            ));
        }
        if *purpose_matches != Some(true) {
            return Err(thrown(
                "Observation request ID was reused for a different purpose.",
            ));
        }
        if let ("complete", Some(id)) = (status.as_str(), observation_id) {
            let row = sqlx::query(COMPLETED)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(failed)?;
            let Some(row) = row else {
                return Err(thrown(
                    "Completed inventory observation evidence is missing.",
                ));
            };
            let observation = node_pg::row(&row)?;
            tx.commit().await.map_err(failed)?;
            return Ok(Claim::Complete(observation));
        }
        if status == "capturing" && expires.is_some_and(|at| at > Utc::now()) {
            return Err(thrown(
                "This inventory observation capture is already in progress.",
            ));
        }
    }
    let token: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?;
    if existing.is_some() {
        sqlx::query(
            "UPDATE inventory_complete_observation_requests
          SET status='capturing',claim_token=$2,claim_expires_at=NOW()+INTERVAL '3 minutes',
            observation_id=NULL,error=NULL,updated_at=NOW() WHERE request_id=$1",
        )
        .bind(request_id)
        .bind(&token)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    } else {
        sqlx::query(
            "INSERT INTO inventory_complete_observation_requests
          (request_id,seller_key,purpose_evidence,status,claim_token,claim_expires_at)
          VALUES ($1,$2,$3::jsonb,'capturing',$4,NOW()+INTERVAL '3 minutes')",
        )
        .bind(request_id)
        .bind(seller)
        .bind(purpose.to_string())
        .bind(&token)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    }
    tx.commit().await.map_err(failed)?;
    Ok(Claim::Claimed(token))
}

/// `failObservationCapture`: the request failed with `error`, if this attempt still owns it.
async fn fail(
    conn: &mut PgConnection,
    request_id: &str,
    token: &str,
    error: &str,
) -> Result<(), String> {
    // `error.slice(0,500)`: the first 500 UTF-16 code units.
    let units: Vec<u16> = error.encode_utf16().take(500).collect();
    let error = String::from_utf16_lossy(&units);
    sqlx::query(
        "UPDATE inventory_complete_observation_requests
      SET status='failed',claim_token=NULL,claim_expires_at=NULL,error=$3,updated_at=NOW()
      WHERE request_id=$1 AND status='capturing' AND claim_token=$2",
    )
    .bind(request_id)
    .bind(token)
    .bind(error)
    .execute(&mut *conn)
    .await
    .map(|_| ())
    .map_err(node_pg::thrown)
}

/// `recordObservation`: the observation saved for the request this attempt claimed, its
/// differences from the seller's last complete one (each changed SKU queued for FIFO replay),
/// and the items of observations no longer needed dropped.
async fn record(
    conn: &mut PgConnection,
    request_id: &str,
    seller: &str,
    token: &str,
    observed: &Observed,
    cutoff_at: DateTime<Utc>,
) -> Result<Value, String> {
    let failed = node_pg::thrown;
    let items = &observed.items;
    let sum = |keep: &dyn Fn(&Item) -> bool| -> i64 {
        items
            .iter()
            .filter(|i| keep(i))
            .map(|i| i64::from(i.quantity))
            .sum()
    };
    let count = |keep: &dyn Fn(&Item) -> bool| items.iter().filter(|i| keep(i)).count() as i64;
    let total_quantity = sum(&|_| true);
    let supported_total = sum(&|i| i.sku.is_some());
    let positive = count(&|i| i.quantity > 0);
    let positive_skus = count(&|i| i.sku.is_some() && i.quantity > 0);
    let unsupported_positive = count(&|i| i.sku.is_none() && i.quantity > 0);
    let unsupported_positive_quantity = sum(&|i| i.sku.is_none() && i.quantity > 0);
    let quantity_fingerprint = observation::quantity_fingerprint(items);
    let supported_fingerprint = observation::supported_quantity_fingerprint(items);
    if observed.before_count < 2 || observed.after_count < 2 || items.len() > 50_000 {
        return Err(thrown("Inventory observation evidence is invalid."));
    }
    let mut tx = conn.begin().await.map_err(failed)?;
    let request: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT seller_key,status,claim_token FROM inventory_complete_observation_requests
         WHERE request_id=$1 FOR UPDATE",
    )
    .bind(request_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let owned = request.is_some_and(|(s, status, claim)| {
        s == seller && status == "capturing" && claim.as_deref() == Some(token)
    });
    if !owned {
        return Err(thrown("Inventory observation capture claim was lost."));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("opening-observation:{seller}"))
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    if observed.started_at > cutoff_at {
        return Err(thrown("Inventory observation cutoff precedes its start."));
    }
    let latest: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT cutoff_at FROM inventory_complete_observations
         WHERE seller_key=$1 ORDER BY cutoff_at DESC,id DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if latest.is_some_and(|at| at.timestamp_millis() >= cutoff_at.timestamp_millis()) {
        return Err(thrown(
            "Inventory observations must advance the seller cutoff.",
        ));
    }
    let previous: Option<(String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id::text,cutoff_at FROM inventory_complete_observations
         WHERE seller_key=$1 AND status='complete' ORDER BY cutoff_at DESC,id DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let status = if observed.stable {
        "complete"
    } else {
        "unstable"
    };
    let error = (!observed.stable).then_some("Seller quantities changed between complete exports.");
    let identity = json!({
        "sellerKey": seller,
        "checkedBeforeAndAfter": true,
        "beforeDeclarationCount": observed.before_count,
        "afterDeclarationCount": observed.after_count,
    });
    let id: String = sqlx::query_scalar(
        "INSERT INTO inventory_complete_observations (
          request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,
          quantity_fingerprint,supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,
          item_count,positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
          unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence,error
        ) VALUES ($1,$2,'seller_portal_live_export',$3,'sellable_excludes_reserved',$4,$5,$6,$7,$8,$9,
          $10::int,$11::int,$12::int,$13::int,$14::int,$15::int,$16::int,$17::jsonb,$18)
        RETURNING id::text",
    )
    .bind(request_id)
    .bind(seller)
    .bind(status)
    .bind(observed.started_at)
    .bind(cutoff_at)
    .bind(&quantity_fingerprint)
    .bind(&supported_fingerprint)
    .bind(&observed.first_content)
    .bind(&observed.second_content)
    .bind(items.len() as i64)
    .bind(positive)
    .bind(total_quantity)
    .bind(positive_skus)
    .bind(supported_total)
    .bind(unsupported_positive)
    .bind(unsupported_positive_quantity)
    .bind(identity.to_string())
    .bind(error)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    let rows: Vec<Value> = items
        .iter()
        .map(|i| {
            json!({
                "inventoryKey": i.inventory_key,
                "identityKind": i.identity_kind(),
                "sku": i.sku,
                "quantity": i.quantity,
            })
        })
        .collect();
    sqlx::query(
        r#"INSERT INTO inventory_complete_observation_items (observation_id,inventory_key,identity_kind,sku,quantity)
         SELECT $1::bigint,x."inventoryKey",x."identityKind",x.sku,x.quantity
         FROM jsonb_to_recordset($2::jsonb) AS x("inventoryKey" text,"identityKind" text,sku integer,quantity integer)"#,
    )
    .bind(&id)
    .bind(Value::Array(rows).to_string())
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    if let (Some((previous_id, previous_cutoff)), true) = (&previous, observed.stable) {
        sqlx::query(
            "INSERT INTO inventory_observation_differences
              (seller_key,previous_observation_id,observation_id,inventory_key,sku,quantity_delta,previous_quantity,observed_quantity)
             SELECT $1,$2::bigint,$3::bigint,COALESCE(old.inventory_key,current.inventory_key),COALESCE(old.sku,current.sku),
               COALESCE(current.quantity,0)-COALESCE(old.quantity,0),
               COALESCE(old.quantity,0),COALESCE(current.quantity,0)
             FROM (SELECT inventory_key,sku,quantity FROM inventory_complete_observation_items WHERE observation_id=$2::bigint) old
             FULL JOIN (SELECT inventory_key,sku,quantity FROM inventory_complete_observation_items WHERE observation_id=$3::bigint) current
               USING (inventory_key)
             WHERE COALESCE(current.quantity,0)<>COALESCE(old.quantity,0)",
        )
        .bind(seller)
        .bind(previous_id)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
        let changed: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT sku FROM inventory_observation_differences
             WHERE observation_id=$1::bigint AND sku IS NOT NULL ORDER BY sku",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(failed)?;
        for sku in changed {
            queue::enqueue(&mut tx, seller, sku, *previous_cutoff)
                .await
                .map_err(failed)?;
        }
    }
    sqlx::query(
        "DELETE FROM inventory_complete_observation_items item
        WHERE item.observation_id IN (
          SELECT old.id FROM inventory_complete_observations old
          WHERE old.seller_key=$1
            AND old.id NOT IN (
              SELECT recent.id FROM inventory_complete_observations recent
              WHERE recent.seller_key=$1 ORDER BY recent.cutoff_at DESC,recent.id DESC LIMIT 3
            )
            AND NOT EXISTS (
              SELECT 1 FROM inventory_opening_balance_runs run
              WHERE run.observation_id=old.id OR run.validation_observation_id=old.id
            )
            AND old.id <> COALESCE((
              SELECT latest.id FROM inventory_complete_observations latest
              WHERE latest.seller_key=$1 AND latest.status='complete'
              ORDER BY latest.cutoff_at DESC,latest.id DESC LIMIT 1
            ),-1)
        )",
    )
    .bind(seller)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    sqlx::query(
        "UPDATE inventory_complete_observation_requests
        SET status='complete',claim_token=NULL,claim_expires_at=NULL,observation_id=$2::bigint,updated_at=NOW()
        WHERE request_id=$1",
    )
    .bind(request_id)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(json!({
        "id": id,
        "sellerKey": seller,
        "status": status,
        "quantityFingerprint": quantity_fingerprint,
        "supportedQuantityFingerprint": supported_fingerprint,
        "itemCount": items.len(),
        "positiveItemCount": positive,
        "observedTotalQuantity": total_quantity,
        "positiveSkuCount": positive_skus,
        "totalQuantity": supported_total,
        "unsupportedPositiveItemCount": unsupported_positive,
        "unsupportedPositiveQuantity": unsupported_positive_quantity,
    }))
}
