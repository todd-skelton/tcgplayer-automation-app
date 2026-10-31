//! Inventory Strategy: what the selling earned and how capital should turn over. Ported from
//! `app/features/inventory-strategy`: realized performance and margin over time, what to change,
//! the active policy's verdict and the hurdle sweep, the capital turnaround, and the selling
//! history, all computed here with the Node app's queries and rounding.
//!
//! Refreshing the seller's inventory and queueing a fresh analysis stay the Node app's
//! (`/api/continuous-pricing`, `/api/inventory-strategy-analysis`): they call TCGplayer and queue
//! work for its pricing worker. The forecast evidence the selling history shows is completed by a
//! task (`backfill`), not by the page, which only reads.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-strategy` | the screen; `?history_days=&history_product_line=` scope the selling history; the layout's toaster says what the last post did |
//! | `POST /inventory-strategy/turnaround` | the seller's turnaround source and manual days saved, or the form with what is wrong |
//! | `POST /inventory-strategy/refresh` | the seller's inventory read again from TCGplayer |
//! | `POST /inventory-strategy/analysis` | a strategy analysis batch queued, or the one already running |
//! | `GET /inventory-strategy/analysis/{batch}` | the latest analysis's status, read again while it runs; the screen once it ends |
//!
//! A post the Node app refuses answers 409 with the page and why.
#![allow(
    dead_code,
    reason = "the domain is ported whole; the screen reads part of it"
)]
mod actions;
pub mod backfill;
mod cache;
pub(crate) mod collate;
pub mod dashboard;
pub mod levers;
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

#[corten::routes(area = InventoryStrategy, state = crate::app::Shared)]
pub mod url {
    #[route("/inventory-strategy", get = show)]
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

    /// The selling history's scope, and what the last post did. A window the screen no longer
    /// offers (an old bookmark) reads as unset, so as the default one, as the React screen read it.
    #[derive(Clone, Debug, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct View {
        pub history_days: Option<super::selling_history::Window>,
        pub history_product_line: Option<String>,
        /// The realized performance window shown; an old bookmark's reads as the default.
        pub realized: Option<super::performance::RealizedWindow>,
    }

    impl View {
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
