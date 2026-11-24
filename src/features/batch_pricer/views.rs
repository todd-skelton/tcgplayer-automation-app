//! The Batch Pricer screen. Its stylesheets and script are next to it in `views/`.
use corten::Component;

mod batch_panel;
mod batch_summary;
mod manual_review;
mod pricer_screen;
mod publication_repair;
mod publish_dialog;

pub use batch_panel::{BatchFollow, BatchPanel, BatchProblem, Refused};
pub use manual_review::{ManualReview, PriceForm};
pub use pricer_screen::{CsvForm, PricerScreen, SellerForm};
pub use publication_repair::{ConfirmForm, PublicationRepair};

/// `PricerScreen`, `BatchPanel`, `BatchSummary`, `PublicationRepair` and `ManualReview` hold their
/// stylesheets, `PublishDialog` its stylesheet and script, and `PublishItem` is the view that
/// script reads.
pub const COMPONENTS: &[Component] = &[
    PricerScreen,
    BatchPanel,
    batch_summary::BatchSummary,
    PublicationRepair,
    ManualReview,
    publish_dialog::PublishDialog,
    publish_dialog::PublishItem,
];
