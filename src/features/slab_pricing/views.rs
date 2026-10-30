//! Slab Pricing's views. Each component's stylesheet is next to it in `views/`.
use corten::Component;

mod comp_review;
mod kept_choice;
mod publication_panel;
mod recommendation_panel;
mod research_panel;
mod seller_panels;
mod slab_screen;
mod supply_panel;

pub use comp_review::CompReview;
pub use kept_choice::KeptChoice;
pub use publication_panel::PublicationPanel;
pub use recommendation_panel::RecommendationPanel;
pub use research_panel::{EvidenceList, ResearchPanel};
pub use seller_panels::{MaintenanceStatusPart, SellerPanels};
pub use slab_screen::{Problem, SlabScreen};
pub use supply_panel::{SupplyBody, SupplyPanel};

pub const COMPONENTS: &[Component] = &[
    SlabScreen,
    ResearchPanel,
    SupplyPanel,
    RecommendationPanel,
    PublicationPanel,
    CompReview,
    SellerPanels,
];
