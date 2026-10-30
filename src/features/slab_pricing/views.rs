//! Slab Pricing's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod recommendation_panel;
mod research_panel;
mod slab_screen;

pub use recommendation_panel::RecommendationPanel;
pub use research_panel::{EvidenceList, ResearchPanel};
pub use slab_screen::{Problem, SlabScreen};

pub const COMPONENTS: &[Component] = &[SlabScreen, ResearchPanel, RecommendationPanel];
