//! Inventory Economics' views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod economics_screen;

pub use economics_screen::EconomicsScreen;

pub const COMPONENTS: &[Component] = &[EconomicsScreen];
