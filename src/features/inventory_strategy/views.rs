//! The Inventory Strategy screen. Its parts share one stylesheet, next to the screen in `views/`.
use corten::{Component, UrlValue};
use serde::Deserialize;

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

/// What the last post did, for the message at the top of the page it was sent back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Saved,
    Refreshed,
    Queued,
    AlreadyQueued,
}

/// An analysis batch still at work, as the Node app names its state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// The message for what the last post did, as the React screen wrote it.
pub fn said(view: &super::url::View, t: crate::text::Msg) -> Option<String> {
    let n = |v: Option<i64>| format::count(t, v.unwrap_or(0));
    let batch = view.batch.unwrap_or(0);
    Some(match view.done? {
        Done::Saved => "Saved the turnaround source and manual days.".into(),
        Done::Refreshed => format!("Refreshed {} listed inventory SKUs.", n(view.count)),
        Done::Queued => format!(
            "Queued strategy analysis batch {batch} for {} SKUs.",
            n(view.items)
        ),
        Done::AlreadyQueued => format!(
            "Strategy analysis batch {batch} is already {}.",
            view.state.map_or("running", BatchState::word)
        ),
    })
}
