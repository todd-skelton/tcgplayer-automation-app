//! Publishes a claimed staged publication through Seller Portal
//! (`executeClaimedStagedPublication`): its planned items uploaded as quantity deltas and prices
//! in chunks, the upload finalized and moved live, and each item's outcome saved from what
//! Seller Portal answered.
//!
//! Before anything moves live a failure rolls the upload back, and the items fail, a continuous
//! publication's SKUs priced again soon as after a failed pricing; if the rollback fails too, or
//! once the move to live was asked for, what Seller Portal did is unknown and the publication is
//! left ambiguous for a person to reconcile. Rows Seller Portal refused because their product
//! details did not match fail on their own, and the rest go on.
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    projection::{self, PRODUCT_DETAILS_MISMATCH},
    seller_portal::{
        self as portal, AUTHENTICATION_REQUIRED, CHUNK_SIZE, Failure, Poster, Update, message_text,
        quoted_messages,
    },
    store::{self, Item, ItemOutcome, Moved, Outcome, Publication, Status},
};
use crate::features::{batch_pricing::save, publication_configuration::config};

/// Whether the failure means Seller Portal wants the seller signed in again
/// (`isSellerPortalAuthenticationFailure`).
pub fn authentication_failure(failure: &Failure) -> bool {
    if failure.initialization == Some(AUTHENTICATION_REQUIRED)
        || matches!(failure.status, Some(401 | 403))
    {
        return true;
    }
    let message = failure.message.to_lowercase();
    [
        "unauthorized",
        "forbidden",
        "sign in",
        "signin",
        "log in",
        "login",
        "authentication",
        "auth cookie",
    ]
    .iter()
    .any(|indicator| message.contains(indicator))
}

/// The SKUs Seller Portal's messages say did not match their product details, when they are
/// exactly as many as it refused (`findExactProductDetailMismatchSkus`).
pub fn exact_product_detail_mismatches(
    messages: Option<&[Value]>,
    submitted: &[i64],
    expected_rejected: f64,
) -> Option<Vec<i64>> {
    let messages = messages.filter(|m| !m.is_empty())?;
    // NaN (an unreadable count) is refused with the rest.
    let counted = expected_rejected > 0.0 && expected_rejected <= submitted.len() as f64;
    if !counted {
        return None;
    }
    let mismatch = Regex::new(r"(?i)does not match product details").expect("valid");
    let mismatches: Vec<String> = messages
        .iter()
        .map(message_text)
        .filter(|message| mismatch.is_match(message))
        .collect();
    if mismatches.is_empty() {
        return None;
    }
    let mut rejected: Vec<i64> = Vec::new();
    for sku in submitted {
        let named =
            Regex::new(&format!(r"(?-u:\b){sku}(?-u:\b)")).expect("a number is a valid pattern");
        if mismatches.iter().any(|m| named.is_match(m)) && !rejected.contains(sku) {
            rejected.push(*sku);
        }
    }
    (rejected.len() as f64 == expected_rejected).then_some(rejected)
}

/// A value as JavaScript writes it into text.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

fn mismatch_outcomes(items: &[&Item], rejected: &HashSet<i64>) -> Vec<ItemOutcome> {
    items
        .iter()
        .filter(|item| rejected.contains(&i64::from(item.sku)))
        .map(|item| ItemOutcome {
            item_id: item.id,
            outcome: Outcome::Failed,
            error_code: Some(PRODUCT_DETAILS_MISMATCH.into()),
            error_message: Some(
                "TCGplayer reports that this SKU does not match its product details.".into(),
            ),
            confirmed: None,
        })
        .collect()
}

fn by_sku(items: Option<&Value>) -> Option<HashMap<i64, Option<String>>> {
    let items = items?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                let sku = item.get("ProductConditionId")?.as_i64()?;
                let message = item
                    .get("Message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Some((sku, message))
            })
            .collect(),
    )
}

/// Each item's outcome from Seller Portal's move to live (`buildMoveToLiveOutcomes`): an error
/// fails it, a warning or no word leaves it ambiguous, success publishes it as confirmed.
pub fn move_to_live_outcomes(
    items: &[&Item],
    response: &Value,
    confirmed: Option<(DateTime<Utc>, Value)>,
) -> Result<Vec<ItemOutcome>, Failure> {
    let unread = || Failure::new("Seller Portal's move-to-live answer could not be read.");
    let mut done = by_sku(response.get("Success")).ok_or_else(unread)?;
    done.extend(by_sku(response.get("Update")).ok_or_else(unread)?);
    let warnings = by_sku(response.get("Warning")).ok_or_else(unread)?;
    let errors = by_sku(response.get("Error")).ok_or_else(unread)?;
    Ok(items
        .iter()
        .map(|item| {
            let sku = i64::from(item.sku);
            let ended = |outcome, code: &str, message: Option<String>| ItemOutcome {
                item_id: item.id,
                outcome,
                error_code: Some(code.into()),
                error_message: message,
                confirmed: None,
            };
            if let Some(message) = errors.get(&sku) {
                ended(
                    Outcome::Failed,
                    "seller_portal_item_error",
                    Some(message.clone().unwrap_or_else(|| {
                        "TCGplayer rejected this item while moving pricing live.".into()
                    })),
                )
            } else if let Some(message) = warnings.get(&sku) {
                ended(
                    Outcome::Ambiguous,
                    "seller_portal_item_warning",
                    Some(message.clone().unwrap_or_else(|| {
                        "TCGplayer returned a warning without a confirmed item outcome.".into()
                    })),
                )
            } else if done.contains_key(&sku) {
                ItemOutcome {
                    item_id: item.id,
                    outcome: Outcome::Published,
                    error_code: None,
                    error_message: None,
                    confirmed: confirmed.clone(),
                }
            } else {
                ended(
                    Outcome::Ambiguous,
                    "seller_portal_item_missing",
                    Some("TCGplayer did not return a move-to-live outcome for this item.".into()),
                )
            }
        })
        .collect())
}

/// A date as JavaScript holds it: to the millisecond.
fn millis(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(at.timestamp_millis()).unwrap_or(at)
}

fn failed_in(why: impl std::fmt::Display) -> Failure {
    Failure::new(why.to_string())
}

/// Saves Seller Portal's health after a step, in a transaction of its own, logging rather than
/// answering a failure to save it: the publication's outcome stands whatever its bookkeeping does.
async fn record_health(conn: &mut PgConnection, failure: Option<&Failure>) {
    let saved = async {
        let mut tx = conn.begin().await?;
        match failure {
            Some(failure) => {
                config::record_failure(&mut tx, authentication_failure(failure), &failure.message)
                    .await?
            }
            None => config::record_success(&mut tx).await?,
        }
        tx.commit().await
    };
    if let Err(why) = saved.await {
        let what = if failure.is_some() {
            "failure"
        } else {
            "success"
        };
        tracing::error!("Could not record Seller Portal {what} health: {why}");
    }
}

async fn record_projection(
    conn: &mut PgConnection,
    publication: &Publication,
    outcomes: &[ItemOutcome],
) {
    let saved = async {
        let mut tx = conn.begin().await?;
        projection::record(&mut tx, publication, outcomes).await?;
        tx.commit().await
    };
    if let Err(why) = saved.await {
        tracing::error!("Could not record continuous publication projection: {why}");
    }
}

/// A rolled-back continuous publication's SKUs, priced again soon as after a failed pricing of
/// their batch, logging rather than answering a failure to save it: the rollback stands whatever
/// its bookkeeping does.
async fn record_rolled_back(conn: &mut PgConnection, publication: &Publication) {
    let Some(batch) = publication
        .batch_number
        .filter(|_| publication.source_type == "continuous")
    else {
        return;
    };
    let skus: Vec<i32> = publication.items.iter().map(|item| item.sku).collect();
    if let Err(why) = save::record_batch_failed(conn, batch, Some(&skus)).await {
        tracing::error!(
            "Could not schedule rolled-back publication {}'s SKUs again: {why}",
            publication.id
        );
    }
}

fn by(worker: &str) -> Moved<'_> {
    Moved {
        worker: Some(worker),
        ..Moved::default()
    }
}

fn ending<'a>(worker: &'a str, code: &'a str, message: &'a str) -> Moved<'a> {
    Moved {
        worker: Some(worker),
        error_code: Some(code),
        error_message: Some(message),
    }
}

/// Ends a publication that failed before anything moved live (`failBeforeMove`): an opened
/// upload rolled back and the items failed, or, when the rollback fails too, left ambiguous.
#[allow(
    clippy::too_many_arguments,
    reason = "Node's failBeforeMove, argument for argument"
)]
async fn fail_before_move(
    conn: &mut PgConnection,
    portal: &impl Poster,
    id: i64,
    worker: &str,
    current: Status,
    upload_id: Option<i64>,
    failure: &Failure,
    record: bool,
) -> Result<(), store::Error> {
    let message = failure.message.as_str();
    if record {
        record_health(conn, Some(failure)).await;
    }
    let Some(upload_id) = upload_id else {
        let code = failure
            .initialization
            .unwrap_or("staged_initialization_failed");
        store::mark_planned(conn, id, Outcome::Failed, code, message).await?;
        store::transition(
            conn,
            id,
            current,
            Status::Failed,
            ending(worker, code, message),
        )
        .await?;
        return Ok(());
    };
    let rolled_back = async {
        portal::rollback(portal, upload_id).await?;
        let code = "staged_publication_rolled_back";
        store::mark_planned(conn, id, Outcome::Failed, code, message)
            .await
            .map_err(failed_in)?;
        store::transition(
            conn,
            id,
            current,
            Status::RolledBack,
            ending(worker, code, message),
        )
        .await
        .map_err(failed_in)
    }
    .await;
    match rolled_back {
        Ok(publication) => record_rolled_back(conn, &publication).await,
        Err(rollback) => {
            let ambiguous = format!("{message} Rollback also failed: {}", rollback.message);
            let code = "staged_rollback_ambiguous";
            store::mark_planned(conn, id, Outcome::Ambiguous, code, &ambiguous).await?;
            store::transition(
                conn,
                id,
                current,
                Status::Ambiguous,
                ending(worker, code, &ambiguous),
            )
            .await?;
        }
    }
    Ok(())
}

/// Saves outcomes Seller Portal already confirmed, once more if the first save fails: only the
/// local transaction is repeated, never the move to live.
async fn save_confirmed(
    conn: &mut PgConnection,
    id: i64,
    outcomes: &[ItemOutcome],
) -> Result<(), store::Error> {
    if store::save_outcomes(conn, id, outcomes).await.is_ok() {
        return Ok(());
    }
    store::save_outcomes(conn, id, outcomes).await
}

/// Publishes `publication`, claimed by `worker` and staging, through `portal`. Answers an error
/// only when the publication's own state could not be written.
pub async fn execute(
    conn: &mut PgConnection,
    portal: &impl Poster,
    publication: &Publication,
    worker: &str,
) -> Result<(), store::Error> {
    let id = publication.id;
    if publication.method != "staged_delta" {
        return Err(store::Error::Refused(format!(
            "Publication {id} does not use staged delta publishing."
        )));
    }
    if publication.status != Status::Staging.as_str() {
        return Err(store::Error::Refused(format!(
            "Publication {id} must be staging before execution."
        )));
    }
    let planned: Vec<&Item> = publication
        .items
        .iter()
        .filter(|item| item.status == "planned")
        .collect();
    if planned.is_empty() {
        let none = Failure::new("Publication has no planned items.");
        return fail_before_move(
            conn,
            portal,
            id,
            worker,
            Status::Staging,
            None,
            &none,
            false,
        )
        .await;
    }
    let file_name = format!("inventory-publication-{id}.csv");
    let updates: Vec<Update> = planned
        .iter()
        .map(|item| Update {
            sku: item.sku.into(),
            add_to_quantity: item.quantity_delta.into(),
            price: item.desired_price,
        })
        .collect();
    let mut upload_id = None;
    let mut current = Status::Staging;
    let mut rejected: HashSet<i64> = HashSet::new();
    let staged = async {
        let opened = portal::initialize(portal, &file_name).await?;
        upload_id = Some(opened);
        store::record_upload(conn, id, worker, opened)
            .await
            .map_err(failed_in)?;
        let mut successful = 0i64;
        for chunk in updates.chunks(CHUNK_SIZE) {
            let uploaded = portal::upload(portal, &file_name, opened, chunk).await?;
            let accepted = uploaded.successful.as_ref().and_then(Value::as_f64);
            if accepted == Some(chunk.len() as f64) {
                successful += chunk.len() as i64;
                continue;
            }
            let skus: Vec<i64> = chunk.iter().map(|update| update.sku).collect();
            let expected = accepted.map_or(f64::NAN, |accepted| chunk.len() as f64 - accepted);
            let Some(mismatched) =
                exact_product_detail_mismatches(uploaded.messages.as_deref(), &skus, expected)
            else {
                let accepted = js_text(uploaded.successful.as_ref());
                let quoted = quoted_messages(uploaded.messages.as_deref());
                let mut message = format!(
                    "TCGplayer accepted {accepted} of {} staged pricing rows.",
                    chunk.len()
                );
                if !quoted.is_empty() {
                    message = format!("{message} {quoted}");
                }
                return Err(Failure::new(message));
            };
            successful += accepted.map_or(0, |accepted| accepted as i64);
            rejected.extend(mismatched);
        }
        if successful == 0 {
            return Err(Failure::new("TCGplayer accepted no staged pricing rows."));
        }
        portal::finalize(portal, opened, successful).await?;
        let refused = mismatch_outcomes(&planned, &rejected);
        if !refused.is_empty() {
            store::save_outcomes(conn, id, &refused)
                .await
                .map_err(failed_in)?;
        }
        store::transition(conn, id, Status::Staging, Status::Staged, by(worker))
            .await
            .map_err(failed_in)?;
        current = Status::Staged;
        Ok::<_, Failure>(opened)
    }
    .await;
    let upload_id = match staged {
        Ok(opened) => opened,
        Err(failure) => {
            return fail_before_move(conn, portal, id, worker, current, upload_id, &failure, true)
                .await;
        }
    };
    store::transition(conn, id, Status::Staged, Status::Publishing, by(worker)).await?;
    let published = async {
        let accepted: Vec<&Item> = planned
            .iter()
            .copied()
            .filter(|item| !rejected.contains(&i64::from(item.sku)))
            .collect();
        let refused = mismatch_outcomes(&planned, &rejected);
        let response = portal::move_to_live(portal, upload_id).await?;
        let confirmed_at = millis(Utc::now());
        let evidence = json!({
            "source": "seller_portal_move_to_live",
            "stagedPricingUploadId": upload_id,
        });
        let outcomes = move_to_live_outcomes(&accepted, &response, Some((confirmed_at, evidence)))?;
        save_confirmed(conn, id, &outcomes)
            .await
            .map_err(failed_in)?;
        let all: Vec<ItemOutcome> = refused.into_iter().chain(outcomes).collect();
        let ambiguous = all.iter().any(|o| o.outcome == Outcome::Ambiguous);
        let moved = if ambiguous {
            ending(
                worker,
                "seller_portal_item_outcome_ambiguous",
                "One or more Seller Portal item outcomes require reconciliation.",
            )
        } else {
            by(worker)
        };
        let next = if ambiguous {
            Status::Ambiguous
        } else {
            Status::Published
        };
        let projected = store::transition(conn, id, Status::Publishing, next, moved)
            .await
            .map_err(failed_in)?;
        Ok::<_, Failure>((projected, all))
    }
    .await;
    match published {
        Ok((projected, all)) => {
            record_health(conn, None).await;
            record_projection(conn, &projected, &all).await;
        }
        Err(failure) => {
            record_health(conn, Some(&failure)).await;
            let code = "move_to_live_ambiguous";
            store::mark_planned(conn, id, Outcome::Ambiguous, code, &failure.message).await?;
            store::transition(
                conn,
                id,
                Status::Publishing,
                Status::Ambiguous,
                ending(worker, code, &failure.message),
            )
            .await?;
        }
    }
    Ok(())
}

/// Publishes a claimed publication: staged ones through Seller Portal; a direct one fails, as
/// its worker was never built.
pub async fn run_claimed(
    conn: &mut PgConnection,
    portal: &impl Poster,
    publication: &Publication,
    worker: &str,
) -> Result<(), store::Error> {
    if publication.method == "staged_delta" {
        return execute(conn, portal, publication, worker).await;
    }
    let code = "unsupported_publication_method";
    let message = "The direct absolute publication worker is not implemented.";
    store::mark_planned(conn, publication.id, Outcome::Failed, code, message).await?;
    store::transition(
        conn,
        publication.id,
        Status::Publishing,
        Status::Failed,
        ending(worker, code, message),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use super::*;
    use crate::{
        database::Database,
        features::inventory_publication::seller_portal::{Answer, ROLLBACK, Unsuccessful},
    };

    /// Seller Portal answering only a rollback, with success.
    struct RollsBack;

    impl Poster for RollsBack {
        fn post(
            &self,
            path: &str,
            _form: &str,
        ) -> impl Future<Output = Result<Answer, Unsuccessful>> + Send {
            assert_eq!(path, ROLLBACK, "only the rollback is posted");
            async {
                Ok(Answer {
                    status: 200,
                    content_type: Some("json".into()),
                    redirected: Some(false),
                    data: json!({}),
                })
            }
        }
    }

    /// A continuous publication rolled back on the dev database, inside a transaction that is
    /// rolled back: its items fail, and its SKUs, still on its batch, are counted a failed pricing
    /// and due again within 15 minutes; a SKU of the batch it did not carry is left alone.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_rolled_back_continuous_publication_is_priced_again_soon() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let seller = "rust-test-rolled-back";
        let worker = "rust-test";
        let batch: i32 = sqlx::query_scalar(
            "INSERT INTO inventory_batches (status, source_type, source_label)
             VALUES ('priced', 'continuous', $1) RETURNING batch_number",
        )
        .bind(seller)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO continuous_pricing_inventory (seller_key, sku, product_id, product_line_id,
               set_id, product_line, set_name, product_name, condition, quantity, last_observed_at,
               next_price_at, last_batch_number)
             SELECT $1, sku, 1, 1, 1, 'Line', 'Set', 'Product', 'Near Mint', 1, NOW(),
               NOW() + INTERVAL '1 day', $2
             FROM UNNEST(ARRAY[1, 2, 3]) AS sku",
        )
        .bind(seller)
        .bind(batch)
        .execute(&mut *tx)
        .await
        .unwrap();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO inventory_publications (planning_key, batch_number, method, source_type,
               seller_key, status, staged_pricing_upload_id, claimed_by)
             VALUES ($1, $2, 'staged_delta', 'continuous', $1, 'staging', 7001, $3) RETURNING id",
        )
        .bind(seller)
        .bind(batch)
        .bind(worker)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_publication_items (publication_id, candidate_key, batch_number,
               sku, product_id, product_line, set_name, product_name, condition, desired_price,
               priced_at)
             SELECT $1, $3 || ':' || sku, $2, sku, 1, 'Line', 'Set', 'Product', 'Near Mint', 1.5, NOW()
             FROM UNNEST(ARRAY[1, 2]) AS sku",
        )
        .bind(id)
        .bind(batch)
        .bind(seller)
        .execute(&mut *tx)
        .await
        .unwrap();

        let refused = Failure::new("TCGplayer did not accept staged pricing upload 7001.");
        fail_before_move(
            &mut tx,
            &RollsBack,
            id,
            worker,
            Status::Staging,
            Some(7001),
            &refused,
            false,
        )
        .await
        .unwrap();

        let (status, code): (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM inventory_publications WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(
            (status.as_str(), code.as_deref()),
            ("rolled_back", Some("staged_publication_rolled_back"))
        );
        let items: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM inventory_publication_items WHERE publication_id = $1 ORDER BY sku",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(items, ["failed", "failed"]);
        let inventory: Vec<(i32, i32, Option<String>, bool)> = sqlx::query_as(
            "SELECT sku, consecutive_pricing_failures, pause_reason,
                    next_price_at <= NOW() + INTERVAL '15 minutes'
             FROM continuous_pricing_inventory WHERE seller_key = $1 ORDER BY sku",
        )
        .bind(seller)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            inventory,
            vec![(1, 1, None, true), (2, 1, None, true), (3, 0, None, false)]
        );
        tx.rollback().await.unwrap();
    }

    #[test]
    fn only_messages_naming_exactly_the_refused_skus_fail_them() {
        let messages = [
            json!("SKU 12 does not match product details"),
            json!({ "sku": 34, "text": "Does Not Match Product Details" }),
        ];
        assert_eq!(
            exact_product_detail_mismatches(Some(&messages), &[12, 34, 56], 2.0),
            Some(vec![12, 34])
        );
        assert_eq!(
            exact_product_detail_mismatches(Some(&messages), &[12, 34, 56], 1.0),
            None
        );
        assert_eq!(
            exact_product_detail_mismatches(Some(&messages), &[123, 56], 1.0),
            None
        );
        assert_eq!(exact_product_detail_mismatches(None, &[12], 1.0), None);
    }

    #[test]
    fn a_refused_sign_in_reads_as_one() {
        assert!(authentication_failure(&Failure::new(
            "Request failed: Unauthorized"
        )));
        assert!(authentication_failure(&Failure {
            message: "Request failed with status code 403".into(),
            status: Some(403),
            initialization: None,
        }));
        assert!(!authentication_failure(&Failure::new(
            "TCGplayer accepted no staged pricing rows."
        )));
    }
}
