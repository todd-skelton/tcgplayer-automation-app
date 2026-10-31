//! The Inventory Strategy screen. Its parts share one stylesheet, next to the screen in `views/`.
use corten::Component;

mod format;
mod margin_trend;
mod performance_panel;
mod selling_history_panel;
mod strategy_screen;
mod turnaround_panel;
mod verdict_panel;

pub use strategy_screen::{AnalysisStatus, Problem, StrategyScreen};
pub use turnaround_panel::TurnaroundForm;

pub const COMPONENTS: &[Component] = &[StrategyScreen];

/// An analysis batch still at work, as the Node app names its state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchState {
    Queued,
    Pricing,
}

impl BatchState {
    pub fn of(status: &str) -> Option<Self> {
        match status {
            "queued" => Some(BatchState::Queued),
            "pricing" => Some(BatchState::Pricing),
            _ => None,
        }
    }

    fn word(self) -> &'static str {
        match self {
            BatchState::Queued => "queued",
            BatchState::Pricing => "pricing",
        }
    }
}

/// What a post did; the notice on the page it redirects to says it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Did {
    Saved,
    Refreshed {
        count: i64,
    },
    Queued {
        batch: i32,
        items: i64,
    },
    AlreadyQueued {
        batch: i32,
        state: Option<BatchState>,
    },
}

impl Did {
    /// What it did, as the React screen wrote it, counts in the visitor's locale.
    pub fn said(self, t: crate::text::Msg) -> String {
        match self {
            Did::Saved => "Saved the turnaround source and manual days.".into(),
            Did::Refreshed { count } => {
                format!(
                    "Refreshed {} listed inventory SKUs.",
                    format::count(t, count)
                )
            }
            Did::Queued { batch, items } => format!(
                "Queued strategy analysis batch {batch} for {} SKUs.",
                format::count(t, items)
            ),
            Did::AlreadyQueued { batch, state } => format!(
                "Strategy analysis batch {batch} is already {}.",
                state.map_or("running", BatchState::word)
            ),
        }
    }
}
