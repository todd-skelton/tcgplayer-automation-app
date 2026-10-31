//! The Continuous Pricing screen. Its stylesheet is next to it in `views/`.
use corten::Component;

use super::scheduler::Cycle;

mod continuous_screen;

pub use continuous_screen::{ContinuousScreen, Problem, ScheduleForm};

pub const COMPONENTS: &[Component] = &[ContinuousScreen];

/// A cycle's outcome as the Node app names it.
fn word(cycle: Cycle) -> &'static str {
    match cycle {
        Cycle::Disabled => "disabled",
        Cycle::RefreshFailed => "refresh_failed",
        Cycle::Idle => "idle",
        Cycle::Backlogged => "backlogged",
        Cycle::Scheduled { .. } => "scheduled",
    }
}

fn queued(batch_number: i32, item_count: usize) -> String {
    format!("Queued batch {batch_number} with {item_count} SKUs.")
}

/// What a post did; the notice on the page it redirects to says it, as the React screen did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Did {
    Saved,
    Refreshed {
        count: i64,
    },
    Ran(Cycle),
    Applied {
        cached: i64,
        batches: i64,
        remaining: i64,
    },
    MarkedDue {
        count: i64,
        cycle: Cycle,
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
            Did::Ran(cycle) => match cycle {
                Cycle::Scheduled {
                    batch_number,
                    item_count,
                } => f.write_str(&queued(batch_number, item_count)),
                other => write!(f, "Scheduler cycle completed: {}.", word(other)),
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
                let next = match cycle {
                    Cycle::Scheduled {
                        batch_number,
                        item_count,
                    } => queued(batch_number, item_count),
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
        let scheduled = Cycle::Scheduled {
            batch_number: 12,
            item_count: 100,
        };
        assert_eq!(
            Did::Ran(scheduled).to_string(),
            "Queued batch 12 with 100 SKUs."
        );
        assert_eq!(
            Did::Ran(Cycle::RefreshFailed).to_string(),
            "Scheduler cycle completed: refresh_failed."
        );
        assert_eq!(
            Did::MarkedDue {
                count: 40,
                cycle: Cycle::Backlogged
            }
            .to_string(),
            "Marked 40 eligible SKUs due. The existing pricing queue will process the due inventory."
        );
    }
}
