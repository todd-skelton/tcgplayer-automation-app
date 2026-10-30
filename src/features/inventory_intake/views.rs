//! The Inventory Manager screen. Its stylesheet and script are next to it in `views/`.
use corten::Component;

mod intake_screen;

pub use intake_screen::{Counted, IntakeError, IntakeScreen, QuantityField, QueueTotals};

pub const COMPONENTS: &[Component] = &[IntakeScreen];
