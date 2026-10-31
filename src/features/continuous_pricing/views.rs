//! The Continuous Pricing screen. Its stylesheet is next to it in `views/`.
use corten::Component;
use serde::Deserialize;

mod continuous_screen;

pub use continuous_screen::{ContinuousScreen, Problem, ScheduleForm};

pub const COMPONENTS: &[Component] = &[ContinuousScreen];

/// What a scheduler cycle came to, as the Node app names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
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

/// A scheduler cycle's outcome, as the Node app answers it.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cycled {
    pub status: Cycle,
    pub batch_number: Option<i32>,
    pub item_count: Option<i64>,
}

impl Cycled {
    fn queued(&self) -> String {
        format!(
            "Queued batch {} with {} SKUs.",
            self.batch_number.unwrap_or(0),
            self.item_count.unwrap_or(0)
        )
    }
}

/// What a post did; the notice on the page it redirects to says it, as the React screen did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Did {
    Saved,
    Refreshed {
        count: i64,
    },
    Ran(Cycled),
    Applied {
        cached: i64,
        batches: i64,
        remaining: i64,
    },
    MarkedDue {
        count: i64,
        cycle: Cycled,
    },
    Enabled {
        sku: i32,
    },
    Paused {
        sku: i32,
    },
}

impl std::fmt::Display for Did {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Did::Saved => f.write_str("Continuous pricing settings saved."),
            Did::Refreshed { count } => write!(f, "Refreshed {count} seller inventory SKUs."),
            Did::Ran(cycle) => match cycle.status {
                Cycle::Scheduled => f.write_str(&cycle.queued()),
                other => write!(f, "Scheduler cycle completed: {}.", other.word()),
            },
            Did::Applied {
                cached,
                batches,
                remaining,
            } => write!(
                f,
                "Queued {cached} SKUs from saved curves in {batches} batches. {remaining} SKUs remain due for fresh market data or an in-flight publication."
            ),
            Did::MarkedDue { count, cycle } => {
                let next = match cycle.status {
                    Cycle::Scheduled => cycle.queued(),
                    Cycle::Backlogged => {
                        "The existing pricing queue will process the due inventory.".into()
                    }
                    Cycle::RefreshFailed => {
                        "The scheduler will retry after the inventory refresh recovers.".into()
                    }
                    Cycle::Idle => "No inventory is currently schedulable.".into(),
                    Cycle::Disabled => "The scheduler is currently disabled.".into(),
                };
                write!(f, "Marked {count} eligible SKUs due. {next}")
            }
            Did::Enabled { sku } => write!(f, "SKU {sku} enabled."),
            Did::Paused { sku } => write!(f, "SKU {sku} paused."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_post_says_what_it_did_as_the_react_screen_did() {
        let scheduled = Cycled {
            status: Cycle::Scheduled,
            batch_number: Some(12),
            item_count: Some(100),
        };
        assert_eq!(
            Did::Ran(scheduled).to_string(),
            "Queued batch 12 with 100 SKUs."
        );
        let failed = Cycled {
            status: Cycle::RefreshFailed,
            ..scheduled
        };
        assert_eq!(
            Did::Ran(failed).to_string(),
            "Scheduler cycle completed: refresh_failed."
        );
        let backlogged = Cycled {
            status: Cycle::Backlogged,
            batch_number: None,
            item_count: None,
        };
        assert_eq!(
            Did::MarkedDue {
                count: 40,
                cycle: backlogged
            }
            .to_string(),
            "Marked 40 eligible SKUs due. The existing pricing queue will process the due inventory."
        );
    }
}
