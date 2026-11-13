//! Inventory Strategy: what the selling earned and how capital should turn over. Ported from
//! `app/features/inventory-strategy`: realized performance and margin over time, what to change,
//! the active policy's verdict and the hurdle sweep, the capital turnaround, and the selling
//! history, all computed here, rounded as the saved reports were.
//!
//! Refreshing the seller's inventory reads TCGplayer here, as Continuous Pricing's refresh does. The forecast evidence the selling history shows is completed by a
//! task (`backfill`), not by the page, which only reads.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-strategy` | the screen, its slow parts sent by its streams; `?history_days=&history_product_line=` scope the selling history (read in, and alone for a `data-patch` submit); `?whole=true` reads every part in; the layout's toaster says what the last post did |
//! | `GET /inventory-strategy/selling-history/live` | the selling history once read, for `<corten-live>` |
//! | `GET /inventory-strategy/returns/live` | realized performance once read, then the policy and the capital turnaround, for `<corten-live>` |
//! | `POST /inventory-strategy/turnaround` | the seller's turnaround source and manual days saved, or the form with what is wrong |
//! | `POST /inventory-strategy/refresh` | the seller's inventory read again from TCGplayer |
//! | `POST /inventory-strategy/analysis` | a strategy analysis batch queued, or the one already running |
//! | `GET /inventory-strategy/analysis/{batch}` | the latest analysis's status, read again while it runs; the screen once it ends |
//!
//! A refused post answers 409 with the page and why.
//!
//! The screen draws first what the dashboard alone gives (its heading, the analysis and the hurdle
//! sweep, from a dashboard kept between pricing runs). Realized performance, the policy's verdict
//! with the capital turnaround (whose rebuild saves the reinvestment report) and the selling
//! history take seconds, so the page draws each waiting and two `<corten-live>` streams send them
//! once read; without JavaScript each waiting part links to the page with them read in.
#![allow(
    dead_code,
    reason = "the domain is ported whole; the screen reads part of it"
)]
mod actions;
mod analysis_queue;
pub mod backfill;
mod cache;
pub(crate) mod collate;
pub mod dashboard;
pub mod levers;
mod parts;
pub mod performance;
pub mod pricing_changes;
pub mod realized;
pub mod reinvestment;
mod screen;
pub mod selling_history;
pub mod snapshot;
pub mod sold_units;
pub mod strategy;
pub mod turnaround;
pub mod turnaround_settings;
pub mod verdict;
mod views;

#[cfg(test)]
mod parity;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use actions::{analysis, queue_analysis, refresh, save_turnaround, show};
use parts::{returns_live, selling_history_live};

/// The screen may be fetched ahead (a hover over the nav) unless its address reads a slow part in:
/// seconds of work, and for every part a rebuild of the saved reinvestment report (corten#798).
fn cheap(at: &url::InventoryStrategy) -> bool {
    !at.view.reads_returns() && !at.view.reads_selling_history()
}

#[corten::routes(area = InventoryStrategy, state = crate::app::Shared)]
pub mod url {
    #[route("/inventory-strategy", get = show, prefetch = cheap)]
    pub struct InventoryStrategy {
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/turnaround", post = save_turnaround)]
    pub struct SaveTurnaround {
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/refresh", post = refresh)]
    pub struct Refresh {
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/analysis", post = queue_analysis)]
    pub struct QueueAnalysis {
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/analysis/{batch}", get = analysis)]
    pub struct Analysis {
        pub batch: i32,
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/selling-history/live", get = selling_history_live)]
    pub struct SellingHistoryLive {
        #[route(query)]
        pub view: View,
    }

    #[route("/inventory-strategy/returns/live", get = returns_live)]
    pub struct ReturnsLive {
        #[route(query)]
        pub view: View,
    }

    /// The selling history's scope, the realized window shown, and whether the slow parts are read
    /// in. A window the screen no longer offers (an old bookmark) reads as unset, so as the default
    /// one.
    #[derive(Clone, Debug, Default, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct View {
        pub history_days: Option<super::selling_history::Window>,
        pub history_product_line: Option<String>,
        /// The realized performance window shown; an old bookmark's reads as the default.
        pub realized: Option<super::performance::RealizedWindow>,
        /// Every slow part read in before the page is sent: the link a waiting part offers where no
        /// stream will bring it (design Choice 44).
        pub whole: Option<bool>,
    }

    impl View {
        /// Whether the page reads realized performance, the policy and the turnaround in.
        pub fn reads_returns(&self) -> bool {
            self.whole == Some(true)
        }

        /// Whether the page reads the selling history in: for the whole page, or a scope its address
        /// names (the scope form's answer without JavaScript, a bookmark).
        pub fn reads_selling_history(&self) -> bool {
            self.reads_returns()
                || self.history_days.is_some()
                || self.history_product_line.is_some()
        }

        /// This view with every slow part read in.
        pub fn whole(&self) -> View {
            View {
                whole: Some(true),
                ..self.clone()
            }
        }

        /// The selling history's scope: a window it offers, else the default; a product line, or all.
        pub fn scope(&self) -> super::selling_history::Scope {
            let default = super::selling_history::Scope::default();
            let window_days = self
                .history_days
                .map_or(default.window_days, super::selling_history::Window::days);
            let product_line = self
                .history_product_line
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned);
            super::selling_history::Scope {
                window_days,
                product_line,
            }
        }
    }
}
