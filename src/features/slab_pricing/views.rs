//! Slab Pricing's views. The screen's panels share `slab_screen.css`; the comp review, a page of
//! its own, has its own stylesheet.
use corten::Component;

mod comp_review;
mod publication_panel;
mod recommendation_panel;
mod research_panel;
mod seller_panels;
mod slab_screen;
mod supply_panel;

pub use comp_review::CompReview;
pub use publication_panel::PublicationPanel;
pub use recommendation_panel::RecommendationPanel;
pub use research_panel::{EvidenceList, ResearchPanel};
pub use seller_panels::{MaintenanceStatusPart, SellerPanels};
pub use slab_screen::{Problem, SlabScreen};
pub use supply_panel::{SupplyBody, SupplyPanel};

pub const COMPONENTS: &[Component] = &[SlabScreen, CompReview];
