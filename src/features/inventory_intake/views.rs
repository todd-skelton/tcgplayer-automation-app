//! The Inventory Manager screen. Its stylesheet and script are next to it in `views/`.
use corten::Component;

mod background_batches;
mod intake_screen;
mod queue_bar;

pub use background_batches::BackgroundBatches;
pub use intake_screen::{
    BATCHES_EVERY, CountForm, Counted, IntakeError, IntakeRow, IntakeScreen, ListingParts,
    QueueNotice, Queuing, UnqueuedCounts, label, set_search,
};
/// What the screen hands its script, which the types test declares for it.
#[cfg(test)]
pub use intake_screen::{IntakeCounts, IntakeListing};
pub use queue_bar::{ClearConfirm, QueueBar, QueueForm, QueueTotals};

/// `IntakeScreen` holds the screen's stylesheet and script, `IntakeRow` the view its script
/// draws rows through, `set_search` the set search it shares with the server's, and `QueueBar`
/// and `BackgroundBatches` their own stylesheets.
pub const COMPONENTS: &[Component] = &[
    IntakeScreen,
    IntakeRow,
    set_search::COMPONENT,
    QueueBar,
    BackgroundBatches,
];
