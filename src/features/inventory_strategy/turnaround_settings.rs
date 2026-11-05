//! The seller's turnaround settings, one for the seller and one per product line it overrides:
//! `inventoryStrategyTurnaroundRepository`. A save is refused when the configured seller changed
//! since the screen loaded or the line is not the seller's.
use chrono::{DateTime, Utc};

use super::turnaround::{Mode, Setting};
use crate::{database::Database, features::inventory_economics::ledger::proceeds::iso};

/// The most days a manual turnaround may be, as the table's check allows.
pub const MAXIMUM_MANUAL_DAYS: f64 = 3650.0;

type Row = (String, Option<i64>, String, f64, DateTime<Utc>);

const RETURNING: &str = r#"seller_key, product_line_id::bigint, mode,
  manual_turnaround_days::float8, updated_at"#;

fn setting(
    (seller_key, product_line_id, mode, manual_turnaround_days, updated_at): Row,
) -> Setting {
    Setting {
        seller_key,
        product_line_id,
        // The table's check allows only these two.
        mode: Mode::parse(&mode).unwrap_or(Mode::Observed),
        manual_turnaround_days,
        updated_at: Some(iso(updated_at)),
    }
}

fn scope_key(product_line_id: Option<i64>) -> String {
    product_line_id.map_or_else(|| "all".into(), |line| format!("line:{line}"))
}

/// The seller's settings, the seller-wide one first.
pub async fn find_for_seller(db: &Database, seller_key: &str) -> sqlx::Result<Vec<Setting>> {
    let seller = seller_key.trim();
    if seller.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {RETURNING} FROM inventory_strategy_turnaround_settings
         WHERE seller_key=$1 ORDER BY product_line_id NULLS FIRST"
    ))
    .bind(seller)
    .fetch_all(&db.0)
    .await?;
    Ok(rows.into_iter().map(setting).collect())
}

/// What a turnaround form asks to save.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub seller_key: String,
    pub product_line_id: Option<i64>,
    pub mode: Mode,
    pub manual_turnaround_days: f64,
}

/// Saves the setting for the seller the screen was loaded for, if it is still the configured one.
/// The error is the sentence the screen shows.
pub async fn save_for_configured_seller(db: &Database, change: &Change) -> Result<Setting, String> {
    let seller = change.seller_key.trim();
    if seller.is_empty() {
        return Err("Seller key is required.".into());
    }
    if change
        .product_line_id
        .is_some_and(|line| line <= 0 || line > i32::MAX as i64)
    {
        return Err("Product line is invalid.".into());
    }
    let days = change.manual_turnaround_days;
    if !days.is_finite() || !(0.0..=MAXIMUM_MANUAL_DAYS).contains(&days) {
        return Err("Manual turnaround must be between 0 and 3,650 days.".into());
    }
    let failed = |e: sqlx::Error| {
        eprintln!("Turnaround setting save failed: {e}");
        "Turnaround setting could not be saved.".to_string()
    };
    let mut tx = db.0.begin().await.map_err(failed)?;
    let configured: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT settings_json#>>'{continuousPricing,sellerKey}' FROM inventory_publication_settings
         WHERE config_key='default' FOR SHARE",
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if configured.and_then(|(key,)| key).as_deref().map(str::trim) != Some(seller) {
        return Err(
            "The configured seller changed. Reload Inventory Strategy before saving.".into(),
        );
    }
    if let Some(line) = change.product_line_id {
        let (owned,): (bool,) = sqlx::query_as(
            "SELECT EXISTS(SELECT 1 FROM continuous_pricing_inventory WHERE seller_key=$1 AND product_line_id=$2)",
        )
        .bind(seller)
        .bind(line as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?;
        if !owned {
            return Err("This product line is not available for the configured seller.".into());
        }
    }
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO inventory_strategy_turnaround_settings
           (seller_key, scope_key, product_line_id, mode, manual_turnaround_days)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (seller_key, scope_key) DO UPDATE SET
           product_line_id=EXCLUDED.product_line_id, mode=EXCLUDED.mode,
           manual_turnaround_days=EXCLUDED.manual_turnaround_days, updated_at=NOW()
         RETURNING {RETURNING}"
    ))
    .bind(seller)
    .bind(scope_key(change.product_line_id))
    .bind(change.product_line_id.map(|line| line as i32))
    .bind(change.mode.as_str())
    .bind(days)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(setting(row))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Saves to the dev database for the configured seller and removes what it saved; it refuses
    /// to run when the seller already has settings, so nothing of Todd's is overwritten.
    #[tokio::test]
    #[ignore = "writes to the dev database, then removes what it wrote"]
    async fn settings_save_by_seller_and_line_and_refuse_a_changed_seller() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let (seller,): (String,) = sqlx::query_as(
            "SELECT settings_json#>>'{continuousPricing,sellerKey}' FROM inventory_publication_settings WHERE config_key='default'",
        )
        .fetch_one(&db.0)
        .await
        .unwrap();
        assert!(
            find_for_seller(&db, &seller).await.unwrap().is_empty(),
            "the seller has no settings to overwrite"
        );
        let (line,): (i64,) = sqlx::query_as(
            "SELECT product_line_id::bigint FROM continuous_pricing_inventory WHERE seller_key=$1 LIMIT 1",
        )
        .bind(&seller)
        .fetch_one(&db.0)
        .await
        .unwrap();
        let (db_, seller_) = (db.clone(), seller.clone());
        // Spawned, so a failed assertion still reaches the cleanup below.
        let outcome = tokio::spawn(async move {
            let (db, seller) = (db_, seller_);
            let change = |product_line_id, mode, manual_turnaround_days| Change {
                seller_key: seller.clone(),
                product_line_id,
                mode,
                manual_turnaround_days,
            };
            let saved = save_for_configured_seller(&db, &change(None, Mode::Manual, 28.0)).await?;
            assert_eq!(
                (saved.product_line_id, saved.manual_turnaround_days),
                (None, 28.0)
            );
            save_for_configured_seller(&db, &change(Some(line), Mode::Observed, 31.5)).await?;
            let read: Vec<_> = find_for_seller(&db, &seller)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|s| (s.product_line_id, s.mode, s.manual_turnaround_days))
                .collect();
            assert_eq!(
                read,
                [
                    (None, Mode::Manual, 28.0),
                    (Some(line), Mode::Observed, 31.5)
                ]
            );
            let not_owned =
                save_for_configured_seller(&db, &change(Some(9_680_001), Mode::Observed, 14.0))
                    .await;
            assert_eq!(
                not_owned.unwrap_err(),
                "This product line is not available for the configured seller."
            );
            let stale = Change {
                seller_key: format!("{seller}-other"),
                ..change(None, Mode::Observed, 14.0)
            };
            assert_eq!(
                save_for_configured_seller(&db, &stale).await.unwrap_err(),
                "The configured seller changed. Reload Inventory Strategy before saving."
            );
            let too_long =
                save_for_configured_seller(&db, &change(None, Mode::Manual, 3650.5)).await;
            assert_eq!(
                too_long.unwrap_err(),
                "Manual turnaround must be between 0 and 3,650 days."
            );
            Ok::<_, String>(())
        })
        .await;
        sqlx::query("DELETE FROM inventory_strategy_turnaround_settings WHERE seller_key=$1")
            .bind(&seller)
            .execute(&db.0)
            .await
            .unwrap();
        outcome.expect("assertions held").unwrap();
    }
}
