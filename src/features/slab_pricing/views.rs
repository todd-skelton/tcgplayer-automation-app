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
/// whole `Choice`, which almost every form and link here posts or points at, so each of those
/// sends the order on screen, not the one the page was drawn in: a form's `on:submit` calls
/// `ordered::send` and a link's `on:connect` `ordered::link` with these tables. A table not on
/// the page is passed over.
#[derive(Id)]
struct SupplyTableId;
#[derive(Id)]
struct ListingsTableId;
#[derive(Id)]
struct CompsTableId;

/// The screen's sorted tables, as `corten_ui::ordered` takes them.
fn sorted_tables() -> [corten::script::ElementId; 3] {
    use corten_ui::sorted;
    [
        sorted(&SupplyTableId),
        sorted(&ListingsTableId),
        sorted(&CompsTableId),
    ]
}
