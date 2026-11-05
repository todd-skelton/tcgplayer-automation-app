//! Slab Pricing's views. The screen's panels share `slab_screen.css`; the comp review, a page of
//! its own, has its own stylesheet.
use corten::{Component, prelude::*};

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

/// The tables a user sorts in place (`rows::sort`). Each sort's keys are part of the screen's
/// whole `Choice`, which almost every form and link here posts or points at, so those name the
/// tables on their page (`data-order-of`) and carry the order on screen, not the one drawn
/// (corten#930).
#[derive(Id)]
struct SupplyTableId;
#[derive(Id)]
struct ListingsTableId;
#[derive(Id)]
struct CompsTableId;
