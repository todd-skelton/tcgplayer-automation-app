//! Slab Pricing's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod slab_screen;

pub use slab_screen::SlabScreen;

pub const COMPONENTS: &[Component] = &[SlabScreen];
