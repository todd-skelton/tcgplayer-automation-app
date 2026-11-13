//! What the screen shows: what it draws first, and its slow parts, read in with it or later by
//! its streams. Each part that can fail on its own (selling history, turnaround evidence and
//! settings, realized performance) says why and leaves the rest.
use std::sync::Arc;

use chrono::{DateTime, Utc};
use corten::prelude::Errors;

use super::{
    actions::TurnaroundInput,
    dashboard::Dashboard,
    levers::{self, Lever, LeverInput, Modeled},
    performance::PerformanceWindow,
    realized::{self, Realized},
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
};

/// The selling history over a scope, or the sentence the screen shows when it could not be read.
pub type SellingHistory = Result<selling_history::Report, &'static str>;

/// The seller's selling history over `scope`.
pub async fn load_selling_history(
    db: &Database,
    seller: &str,
    scope: &selling_history::Scope,
) -> SellingHistory {
    selling_history::source::load(db, seller, scope, 1)
        .await
        .map_err(|why| {
            tracing::error!("Inventory selling history load failed: {why}");
            "Selling history could not be loaded. Existing strategy analysis is still available."
        })
}

/// The capital turnaround the model uses for the seller, from the reinvestment evidence (rebuilt
/// and saved now) and the saved settings, and the economics it gives the verdict and the levers.
pub struct Turnaround {
    pub selection: Selection,
    pub economics: Economics,
    /// Why the turnaround evidence is not current, when it is not.
    pub reinvestment_error: Option<String>,
    pub settings_error: Option<&'static str>,
}

impl Turnaround {
    pub async fn read(db: &Database, seller: &str, config: &Config) -> Turnaround {
        let ((report, reinvestment_error), saved) = tokio::join!(
            reinvestment::source::load_with_recovery(db, seller),
            turnaround_settings::find_for_seller(db, seller),
        );
        let (saved, settings_error) = match saved {
            Ok(saved) => (saved, None),
            Err(why) => {
                tracing::error!("Inventory Strategy turnaround settings load failed: {why}");
                (
                    Vec::new(),
                    Some(
                        "Saved turnaround settings could not be loaded; using the 28-day manual fallback.",
                    ),
                )
            }
        };
        let selection = turnaround::select(
            seller,
            None,
            &saved,
            report.as_ref(),
            reinvestment_error.as_deref(),
            Utc::now().timestamp_millis() as f64,
        );
        let ppd = &config.pricing.profit_per_day;
        let economics = verdict::strategy_economics(
            ppd.relative_overhead,
            ppd.static_overhead_per_unit,
            selection.effective_days,
        );
        Turnaround {
            selection,
            economics,
            reinvestment_error,
            settings_error,
        }
    }
}

/// `read` when `wanted`; nothing is read otherwise.
async fn read_if<T>(wanted: bool, read: impl Future<Output = T>) -> Option<T> {
    if wanted { Some(read.await) } else { None }
}

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

/// The seller's latest analysis among the ten most recent.
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

/// What the screen draws first, and each slow part read in with it (`None`: its stream sends it).
pub struct Screen {
    pub view: View,
    pub seller_key: String,
    pub config: Config,
    pub dashboard: Arc<Dashboard>,
    pub analysis: Option<Analysis>,
    pub realized: Option<Realized>,
    pub turnaround: Option<Turnaround>,
    pub selling_history: Option<SellingHistory>,
    pub now: DateTime<Utc>,
    /// Why the last post was refused.
    pub problem: Option<String>,
    /// The turnaround form as it was sent, with what is wrong with it, when it was refused.
    pub refused_turnaround: Option<(TurnaroundInput, Errors)>,
}

impl Screen {
    /// The screen with the slow parts its address reads in (`View::reads_returns`,
    /// `View::reads_selling_history`); its streams send the others.
    pub async fn read(db: &Database, view: &View) -> corten::Result<Screen> {
        Self::read_parts(db, view, view.reads_returns(), view.reads_selling_history()).await
    }

    /// The screen as it is drawn first, without its slow parts.
    pub async fn first(db: &Database, view: &View) -> corten::Result<Screen> {
        Self::read_parts(db, view, false, false).await
    }

    async fn read_parts(
        db: &Database,
        view: &View,
        returns: bool,
        history: bool,
    ) -> corten::Result<Screen> {
        let (settings, config) = tokio::join!(store::settings(db), config::load(db));
        let seller = settings?.seller_key;
        let config = config?;
        let scope = view.scope();
        let (dashboard, analysis, (realized, turnaround), selling_history) = tokio::join!(
            strategy::load(db, &seller, &config),
            latest_analysis(db, &seller),
            async {
                tokio::join!(
                    read_if(returns, realized::load_with_recovery(db, &seller)),
                    read_if(returns, Turnaround::read(db, &seller, &config)),
                )
            },
            read_if(history, load_selling_history(db, &seller, &scope)),
        );
        Ok(Screen {
            view: view.clone(),
            seller_key: seller,
            config,
            dashboard: dashboard.map_err(corten::Error::new)?,
            analysis: analysis?,
            realized,
            turnaround,
            selling_history,
            now: Utc::now(),
            problem: None,
            refused_turnaround: None,
        })
    }

    /// The configured hurdle the policy prices at.
    pub fn hurdle(&self) -> f64 {
        self.config.pricing.profit_per_day.daily_return_hurdle
    }

    pub fn profit_per_day(&self) -> bool {
        matches!(self.config.pricing.policy, Policy::ProfitPerDay)
    }

    /// Each hurdle on the sweep that grows capital under the turnaround's economics, best first.
    pub fn hurdle_returns(&self, turnaround: &Turnaround) -> Vec<HurdleReturn<'_>> {
        let overall = &self.dashboard.overall;
        verdict::hurdle_returns(
            &overall.hurdle_sweep,
            Portfolio {
                market_value: overall.estimated_market_value,
                unit_count: overall.unit_count as f64,
            },
            turnaround.economics,
        )
    }

    /// What to change, with realized performance over `window` (none: before anything sold).
    pub fn levers(
        &self,
        turnaround: &Turnaround,
        window: Option<&PerformanceWindow>,
    ) -> Vec<Lever> {
        let returns = self.hurdle_returns(turnaround);
        fn modeled<'a>(r: &HurdleReturn<'a>) -> Modeled<'a> {
            Modeled {
                scenario: r.scenario,
                daily_return: r.daily_return,
            }
        }
        let evidence = turnaround.selection.evidence.as_ref();
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

    /// The turnaround form as drawn: as it was sent when refused, else the turnaround as saved.
    pub fn turnaround_input(&self, turnaround: &Turnaround) -> TurnaroundInput {
        match &self.refused_turnaround {
            Some((input, _)) => input.clone(),
            None => TurnaroundInput::of(&self.seller_key, &turnaround.selection),
        }
    }
}
