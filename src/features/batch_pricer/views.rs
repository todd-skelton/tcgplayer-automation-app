//! The Batch Pricer screen. Its stylesheets and script are next to it in `views/`.
use corten::Component;

mod batch_panel;
mod batch_summary;
mod pricer_screen;
mod publish_dialog;

pub use batch_panel::{BatchFollow, BatchPanel, BatchProblem};
pub use pricer_screen::{CsvForm, PricerScreen, SellerForm};

/// `PricerScreen`, `BatchPanel` and `BatchSummary` hold their stylesheets, `PublishDialog` its
/// stylesheet and script, and `PublishItem` is the view that script reads.
pub const COMPONENTS: &[Component] = &[
    PricerScreen,
    BatchPanel,
    batch_summary::BatchSummary,
    publish_dialog::PublishDialog,
    publish_dialog::PublishItem,
];
