//! Everything the screen shows, read at once as the React route's loader read it: each part that
//! can fail on its own (selling history, turnaround evidence and settings, realized performance)
//! says why and leaves the rest.
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::{
    dashboard::Dashboard,
    levers::{self, Lever, LeverInput, Modeled},
    performance::{PerformanceWindow, RealizedPerformance},
    realized::{self, MarginTrend, Realized},
    reinvestment, selling_history, strategy,
    turnaround::{self, Selection},
    turnaround_settings,
    url::View,
    verdict::{self, HurdleReturn},
};
use crate::{
    database::Database,
    features::{
        configuration::config::{self, Config, Policy},
        continuous_pricing::store,
        pricing::capital_cycle::{Economics, Portfolio},
    },
    zone::Visitor,
};

/// The latest strategy analysis batch for the seller.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Analysis {
    pub batch_number: i32,
    pub status: String,
    pub source_label: Option<String>,
    pub last_priced_at: Option<DateTime<Utc>>,
}

impl Analysis {
    /// Still queued or pricing.
    pub fn active(&self) -> bool {
        is_active(&self.status)
    }
}

pub fn is_active(status: &str) -> bool {
    matches!(status, "queued" | "pricing")
}

/// The seller's latest analysis among the ten most recent, as the React route found it.
pub async fn latest_analysis(db: &Database, seller: &str) -> sqlx::Result<Option<Analysis>> {
    if seller.is_empty() {
        return Ok(None);
    }
    let recent: Vec<Analysis> = sqlx::query_as(
        "SELECT batch_number, status, source_label, last_priced_at FROM inventory_batches
         WHERE source_type = 'strategy' ORDER BY batch_number DESC LIMIT 10",
    )
    .fetch_all(&db.0)
    .await?;
    Ok(recent
        .into_iter()
        .find(|b| b.source_label.as_deref() == Some(seller)))
}

/// One analysis batch's status, for the screen following it.
pub async fn analysis(db: &Database, batch: i32) -> sqlx::Result<Option<Analysis>> {
    sqlx::query_as(
        "SELECT batch_number, status, source_label, last_priced_at FROM inventory_batches
         WHERE batch_number = $1 AND source_type = 'strategy'",
    )
    .bind(batch)
    .fetch_optional(&db.0)
    .await
}

pub struct Screen {
    pub view: View,
    pub seller_key: String,
    pub config: Config,
    pub dashboard: Arc<Dashboard>,
    pub analysis: Option<Analysis>,
    pub selling_history: Result<selling_history::Report, &'static str>,
    /// Why the turnaround evidence is not current, when it is not.
    pub reinvestment_error: Option<String>,
    pub settings_error: Option<&'static str>,
    pub turnaround: Selection,
    pub economics: Economics,
    pub performance: Option<RealizedPerformance>,
    pub margin_trend: Option<MarginTrend>,
    pub performance_error: Option<&'static str>,
    pub visitor: Visitor,
    pub now: DateTime<Utc>,
    /// Why the last post was refused.
    pub problem: Option<String>,
}

impl Screen {
    pub async fn read(db: &Database, view: &View, visitor: Visitor) -> corten::Result<Screen> {
        let (settings, config) = tokio::join!(store::settings(db), config::load(db));
        let seller = settings?.seller_key;
        let config = config?;
        let scope = view.scope();
        let (dashboard, analysis, history, (report, reinvestment_error), saved, realized) = tokio::join!(
            strategy::load(db, &seller, &config),
            latest_analysis(db, &seller),
            selling_history::source::load(db, &seller, &scope, 1),
            reinvestment::source::load_with_recovery(db, &seller),
            turnaround_settings::find_for_seller(db, &seller),
            realized::load_with_recovery(db, &seller),
        );
        let dashboard = dashboard.map_err(corten::Error::new)?;
        let selling_history = history.map_err(|why| {
            eprintln!("Inventory selling history load failed: {why}");
            "Selling history could not be loaded. Existing strategy analysis is still available."
        });
        let (saved, settings_error) = match saved {
            Ok(saved) => (saved, None),
            Err(why) => {
                eprintln!("Inventory Strategy turnaround settings load failed: {why}");
                (
                    Vec::new(),
                    Some(
                        "Saved turnaround settings could not be loaded; using the 28-day manual fallback.",
                    ),
                )
            }
        };
        let now = Utc::now();
        let turnaround = turnaround::select(
            &dashboard.seller_key,
            None,
            &saved,
            report.as_ref(),
            reinvestment_error.as_deref(),
            now.timestamp_millis() as f64,
        );
        let ppd = &config.pricing.profit_per_day;
        let economics = verdict::strategy_economics(
            ppd.relative_overhead,
            ppd.static_overhead_per_unit,
            turnaround.effective_days,
        );
        let Realized {
            report: performance,
            margin_trend,
            error: performance_error,
        } = realized;
        Ok(Screen {
            view: view.clone(),
            seller_key: seller,
            config,
            dashboard,
            analysis: analysis?,
            selling_history,
            reinvestment_error,
            settings_error,
            turnaround,
            economics,
            performance,
            margin_trend,
            performance_error,
            visitor,
            now,
            problem: None,
        })
    }

    /// The configured hurdle the policy prices at.
    pub fn hurdle(&self) -> f64 {
        self.config.pricing.profit_per_day.daily_return_hurdle
    }

    pub fn profit_per_day(&self) -> bool {
        matches!(self.config.pricing.policy, Policy::ProfitPerDay)
    }

    /// Each hurdle on the sweep that grows capital, best first.
    pub fn hurdle_returns(&self) -> Vec<HurdleReturn<'_>> {
        let overall = &self.dashboard.overall;
        verdict::hurdle_returns(
            &overall.hurdle_sweep,
            Portfolio {
                market_value: overall.estimated_market_value,
                unit_count: overall.unit_count as f64,
            },
            self.economics,
        )
    }

    /// The realized windows the screen offers, or none before anything sold.
    pub fn windows(&self) -> &[PerformanceWindow] {
        self.performance.as_ref().map_or(&[], |p| &p.windows)
    }

    /// What to change, with realized performance over `window` (none: before anything sold).
    pub fn levers(&self, window: Option<&PerformanceWindow>) -> Vec<Lever> {
        let returns = self.hurdle_returns();
        fn modeled<'a>(r: &HurdleReturn<'a>) -> Modeled<'a> {
            Modeled {
                scenario: r.scenario,
                daily_return: r.daily_return,
            }
        }
        let evidence = self.turnaround.evidence.as_ref();
        levers::improvement_levers(&LeverInput {
            configured_hurdle: self.hurdle(),
            best: returns.first().map(modeled),
            configured: returns.iter().find(|r| r.scenario.configured).map(modeled),
            overall: window.map(|w| &w.overall),
            product_lines: window.map_or(&[], |w| &w.product_lines),
            waiting_cents: evidence.map_or(0, |e| e.waiting_cents),
            oldest_waiting_days: evidence.and_then(|e| e.oldest_waiting_days),
            modeled_units: self.dashboard.overall.modeled_unit_count,
            total_units: self.dashboard.overall.unit_count,
        })
    }
}
