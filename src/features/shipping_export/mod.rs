//! Shipping Workflow: load the orders ready to ship, pull their cards, buy their postage, print
//! the labels and packing slips, pack each shipment, then mark the orders shipped and tell their
//! buyers. Ported from `app/features/shipping-export/routes/shipping-export.tsx`.
//!
//! TCGplayer, EasyPost and their records stay the Node app's, so loading orders, postage and
//! marking orders shipped go through its `/api/shipping-export/*` routes. The batch in progress
//! is kept in the database (`workflow`), where the React screen kept it in each browser's
//! localStorage: a reload, a second tab or another computer continues the same batch. The step is
//! the page's address; with none, the screen opens at the first step not done.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /shipping-export` | the step `?step=` (or the first not done) of the batch in progress; `?seller=` chooses the seller to load for |
//! | `POST /shipping-export/orders` | the seller's Ready to Ship orders loaded as a new batch |
//! | `POST /shipping-export/order` | one order loaded as a new batch |
//! | `POST /shipping-export/history` | the seller's order history scan moved on |
//! | `POST /shipping-export/history/import` | an older order CSV added to the seller's order history |
//! | `POST /shipping-export/new-batch` | the batch dropped |
mod orders;
mod page;
#[allow(
    dead_code,
    reason = "the Buy Postage, Print, Pack and Ship steps still to land use the rest"
)]
mod postage;
#[allow(dead_code, reason = "the Ship step still to land uses it")]
mod ship;
#[allow(
    dead_code,
    reason = "the Buy Postage and Pack steps still to land use the rest"
)]
mod shipments;
mod source;
mod steps;
mod value;
mod views;
#[allow(
    dead_code,
    reason = "the Print and Pack steps still to land use the rest"
)]
mod workflow;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{catch_up, import_history, load_order, load_orders, new_batch, show};

#[corten::routes(area = ShippingWorkflow, state = crate::app::Shared)]
pub mod url {
    use super::steps::Step;
    use crate::features::pull_sheet::url::SheetQuery;

    /// `step` is the step shown, the first not done when none; `seller` the seller the Load
    /// Orders step loads for; `filters` the pull sheet's filter and sort without JavaScript.
    #[route("/shipping-export", get = show)]
    pub struct ShippingWorkflow {
        pub step: Option<Step>,
        pub seller: Option<String>,
        #[route(query)]
        pub filters: SheetQuery,
    }

    #[route("/shipping-export/orders", post = load_orders)]
    pub struct LoadOrders;

    #[route("/shipping-export/order", post = load_order)]
    pub struct LoadOrder;

    #[route("/shipping-export/history", post = catch_up)]
    pub struct OrderHistory;

    #[route("/shipping-export/history/import", post = import_history)]
    pub struct ImportHistory;

    #[route("/shipping-export/new-batch", post = new_batch)]
    pub struct NewBatch;
}
