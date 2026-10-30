//! The Continuous Pricing screen. Its stylesheet is next to it in `views/`.
use corten::{Component, UrlValue};
use serde::Deserialize;

mod continuous_screen;

pub use continuous_screen::{ContinuousScreen, Problem, ScheduleForm};

pub const COMPONENTS: &[Component] = &[ContinuousScreen];

/// What the last post did, for the message at the top of the page it was sent back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Saved,
    Refreshed,
    Ran,
    Applied,
    MarkedDue,
    Enabled,
    Paused,
}

/// What a scheduler cycle came to, as the Node app names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cycle {
    Disabled,
    RefreshFailed,
    Idle,
    Backlogged,
    Scheduled,
}

impl Cycle {
    fn word(self) -> &'static str {
        match self {
            Cycle::Disabled => "disabled",
            Cycle::RefreshFailed => "refresh_failed",
            Cycle::Idle => "idle",
            Cycle::Backlogged => "backlogged",
            Cycle::Scheduled => "scheduled",
        }
    }
}

/// The message for what the last post did, as the React screen wrote it.
pub fn said(view: &super::url::View) -> Option<String> {
    let n = |v: Option<i64>| v.unwrap_or(0);
    let queued = || {
        format!(
            "Queued batch {} with {} SKUs.",
            view.batch.unwrap_or(0),
            n(view.items)
        )
    };
    Some(match view.done? {
        Done::Saved => "Continuous pricing settings saved.".into(),
        Done::Refreshed => format!("Refreshed {} seller inventory SKUs.", n(view.count)),
        Done::Ran => match view.cycle {
            Some(Cycle::Scheduled) => queued(),
            other => format!(
                "Scheduler cycle completed: {}.",
                other.map_or("unknown", Cycle::word)
            ),
        },
        Done::Applied => format!(
            "Queued {} SKUs from saved curves in {} batches. {} SKUs remain due for fresh market data or an in-flight publication.",
            n(view.count),
            n(view.batches),
            n(view.remaining)
        ),
        Done::MarkedDue => {
            let cycle = match view.cycle {
                Some(Cycle::Scheduled) => queued(),
                Some(Cycle::Backlogged) => {
                    "The existing pricing queue will process the due inventory.".into()
                }
                Some(Cycle::RefreshFailed) => {
                    "The scheduler will retry after the inventory refresh recovers.".into()
                }
                Some(Cycle::Idle) => "No inventory is currently schedulable.".into(),
                Some(Cycle::Disabled) | None => "The scheduler is currently disabled.".into(),
            };
            format!("Marked {} eligible SKUs due. {cycle}", n(view.count))
        }
        Done::Enabled => format!("SKU {} enabled.", view.sku.unwrap_or(0)),
        Done::Paused => format!("SKU {} paused.", view.sku.unwrap_or(0)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::continuous_pricing::url::View;

    #[test]
    fn each_post_says_what_it_did_as_the_react_screen_did() {
        let ran = View {
            done: Some(Done::Ran),
            cycle: Some(Cycle::Scheduled),
            batch: Some(12),
            items: Some(100),
            ..View::default()
        };
        assert_eq!(said(&ran).unwrap(), "Queued batch 12 with 100 SKUs.");
        let idle = View {
            cycle: Some(Cycle::RefreshFailed),
            ..ran.clone()
        };
        assert_eq!(
            said(&idle).unwrap(),
            "Scheduler cycle completed: refresh_failed."
        );
        let marked = View {
            done: Some(Done::MarkedDue),
            count: Some(40),
            cycle: Some(Cycle::Backlogged),
            ..View::default()
        };
        assert_eq!(
            said(&marked).unwrap(),
            "Marked 40 eligible SKUs due. The existing pricing queue will process the due inventory."
        );
        assert_eq!(said(&View::default()), None);
    }
}
