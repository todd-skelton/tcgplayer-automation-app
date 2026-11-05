//! The Inventory Manager screen. Its stylesheet and script are next to it in `views/`.
use corten::Component;

mod background_batches;
mod intake_screen;
mod queue_bar;

pub use background_batches::BackgroundBatches;
pub use intake_screen::{
    BATCHES_EVERY, CountForm, Counted, IntakeError, IntakeScreen, QueueNotice, Queuing, label,
    redrawn,
};
pub use queue_bar::{ClearConfirm, QueueBar, QueueForm, QueueTotals};

/// `IntakeScreen` holds the screen's stylesheet and script, `QueueBar` and `BackgroundBatches`
/// their own stylesheets.
pub const COMPONENTS: &[Component] = &[IntakeScreen, QueueBar, BackgroundBatches];
