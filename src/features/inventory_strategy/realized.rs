//! What the selling earned, read for the screen: realized performance over the trailing windows,
//! and margin week by week beside the days pricing changed. `realizedPerformance.server.ts`.
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use super::{
    performance::{
        self, MARGIN_TREND_WEEKS, MarginTrendWeek, PERFORMANCE_WINDOWS, PRICING_HISTORY_LEAD_DAYS,
        RealizedPerformance,
    },
    pricing_changes::{self, PricingChange},
    sold_units,
};
use crate::database::Database;

/// Margin week by week, and what changed in pricing over those weeks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginTrend {
    pub weeks: Vec<MarginTrendWeek>,
    pub pricing_changes: Vec<PricingChange>,
}

/// Realized performance and the margin trend, or the sentence the screen shows when they could
/// not be read.
pub struct Realized {
    pub report: Option<RealizedPerformance>,
    pub margin_trend: Option<MarginTrend>,
    pub error: Option<&'static str>,
}

/// The seller's realized performance and margin trend as of `now`. A pricing history that cannot
/// be read leaves the changes out, as the Node app does.
pub async fn load(
    db: &Database,
    seller: &str,
    now: DateTime<Utc>,
) -> Result<(RealizedPerformance, MarginTrend), String> {
    let since = now - Duration::days(MARGIN_TREND_WEEKS * 7 + PRICING_HISTORY_LEAD_DAYS);
    let (lines, history) = tokio::join!(
        sold_units::load(db, seller),
        pricing_changes::history(db, since)
    );
    let lines = lines?;
    let history = history.unwrap_or_else(|e| {
        eprintln!("Pricing change history load failed: {e}");
        Vec::new()
    });
    let weeks = performance::summarize_trend(&lines, now, MARGIN_TREND_WEEKS);
    let pricing_changes = weeks
        .first()
        .map(|first| pricing_changes::describe(&history, &first.week_start))
        .unwrap_or_default();
    Ok((
        performance::summarize_realized(&lines, now, &PERFORMANCE_WINDOWS),
        MarginTrend {
            weeks,
            pricing_changes,
        },
    ))
}

/// [`load`], or why the screen goes on without it.
pub async fn load_with_recovery(db: &Database, seller: &str) -> Realized {
    match load(db, seller, Utc::now()).await {
        Ok((report, margin_trend)) => Realized {
            report: Some(report),
            margin_trend: Some(margin_trend),
            error: None,
        },
        Err(why) => {
            eprintln!("Realized performance load failed: {why}");
            Realized {
                report: None,
                margin_trend: None,
                error: Some(
                    "Realized performance could not be loaded. Modeled strategy is still available.",
                ),
            }
        }
    }
}
