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
//! | `GET /shipping-export` | the step `?step=` (or the first not done) of the batch in progress; `?seller=` chooses the seller to load for, `?edit=` opens a shipment's editor, `?shipment=` and `?view=` are the shipment Pack shows and how |
//! | `POST /shipping-export/orders` | the seller's Ready to Ship orders loaded as a new batch |
//! | `POST /shipping-export/order` | one order loaded as a new batch |
//! | `POST /shipping-export/history` | the seller's order history scan moved on |
//! | `POST /shipping-export/history/import` | an older order CSV added to the seller's order history |
//! | `POST /shipping-export/postage` | postage bought for every shipment, a label size at a time, with one PDF of each size's labels |
//! | `POST /shipping-export/shipments/{reference}/postage` | postage, or a return label, bought for one shipment |
//! | `GET /shipping-export/shipments/{reference}/csv` | the shipment, or its return (`?direction=return`), as EasyPost's CSV |
//! | `POST /shipping-export/shipments/{reference}` | the shipment as edited, kept for the batch |
//! | `GET /shipping-export/packing-slips` | the batch's packing slips as a PDF, shown (`?open=true`) or saved |
//! | `POST /shipping-export/labels/{size}` | one PDF of a label size's labels, made from the postage bought |
//! | `POST /shipping-export/shipments/{reference}/packed` | the shipment marked packed (and the next not packed shown), or not |
//! | `POST /shipping-export/ship` | the orders with production postage marked shipped on TCGplayer, then their buyers told |
//! | `POST /shipping-export/new-batch` | the batch dropped |
mod buying;
mod editing;
mod one_at_a_time;
mod orders;
mod pack;
mod packing;
mod page;
mod postage;
mod printing;
mod sheet;
mod ship;
mod shipments;
mod shipping;
mod source;
mod steps;
mod value;
mod views;
mod workflow;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use buying::{buy_all, buy_shipment, edit_shipment, shipment_csv};
use packing::set_packed;
use page::{catch_up, import_history, load_order, load_orders, new_batch, show};
use printing::{create_batch_label, packing_slips};
use shipping::mark_shipped;

#[corten::routes(area = ShippingWorkflow, state = crate::app::Shared)]
pub mod url {
    use super::{pack::PackView, shipments::Direction, steps::Step};
    use crate::features::{pull_sheet::url::SheetQuery, shipping_configuration::LabelSize};

    /// `step` is the step shown, the first not done when none; `seller` the seller the Load
    /// Orders step loads for; `edit` the shipment whose editor is open; `filters` the pull
    /// sheet's filter and sort without JavaScript; `shipment` the one Pack shows, and `view`
    /// whether as cards or a list.
    #[route("/shipping-export", get = show)]
    pub struct ShippingWorkflow {
        pub step: Option<Step>,
        pub seller: Option<String>,
        pub edit: Option<String>,
        pub shipment: Option<String>,
        pub view: Option<PackView>,
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

    #[route("/shipping-export/postage", post = buy_all)]
    pub struct BuyAllPostage;

    #[route("/shipping-export/shipments/{reference}/postage", post = buy_shipment)]
    pub struct BuyShipmentPostage {
        pub reference: String,
    }

    /// `direction` is the way the CSV's shipment goes: outbound when none.
    #[route("/shipping-export/shipments/{reference}/csv", get = shipment_csv)]
    pub struct ShipmentCsv {
        pub reference: String,
        pub direction: Option<Direction>,
    }

    #[route("/shipping-export/shipments/{reference}", post = edit_shipment)]
    pub struct EditShipment {
        pub reference: String,
    }

    /// `open` shows the PDF in the browser's viewer; without it, it is saved.
    #[route("/shipping-export/packing-slips", get = packing_slips)]
    pub struct PackingSlips {
        pub open: Option<bool>,
    }

    #[route("/shipping-export/labels/{size}", post = create_batch_label)]
    pub struct BatchLabelPdf {
        pub size: LabelSize,
    }

    #[route("/shipping-export/shipments/{reference}/packed", post = set_packed)]
    pub struct ShipmentPacked {
        pub reference: String,
    }

    #[route("/shipping-export/ship", post = mark_shipped)]
    pub struct ShipOrders;

    #[route("/shipping-export/new-batch", post = new_batch)]
    pub struct NewBatch;
}
