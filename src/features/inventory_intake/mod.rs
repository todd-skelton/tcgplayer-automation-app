//! Inventory Manager: count cards into inventory, set by set, a condition at a time, from the
//! keyboard. Ported from `app/features/inventory-management/routes/inventory-manager.tsx`.
//!
//! The filters are a GET form, so a set, a search or a product line is a link. Every product of
//! the set is drawn with a count for each condition, and the condition shown is chosen in the
//! browser (CSS reads the condition select), so stepping through conditions needs no request.
//! A count changed with JavaScript is sent on its own, in order, by the screen's script; without
//! JavaScript the table is one form whose Save button sends every count.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-manager` | the screen for the filters in the query |
//! | `POST /inventory-manager/count` | one SKU's count changed: its field and the totals |
//! | `POST /inventory-manager/counts` | the table's counts saved (without JavaScript) |
//! | `POST /inventory-manager/clear` | every count not yet queued removed |
//! | `POST /inventory-manager/queue` | the counts queued as a pricing batch |
//! | `GET /inventory-manager/batches` | the background batches again, read every 5 seconds |
//! | `POST /inventory-manager/batches/{batch}/rate` | a queued batch estimated at another rate |
//!
//! The React screen kept an unconfirmed queue request in session storage to send again after a
//! reload. Here the form's submit key is the request id, and a reload shows what happened: the
//! batch in the background batches and the counts gone, or the counts still there.
pub(crate) mod catalog;
mod page;
mod pending;
pub mod queue;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{batches, change_rate, clear, count, queue_batch, save_counts, show};

#[corten::routes(area = InventoryManager, state = crate::app::Shared)]
pub mod url {
    use super::catalog::{Condition, ProductType, Scope};

    #[route("/inventory-manager", get = show)]
    pub struct InventoryManager {
        #[route(query)]
        pub selection: Selection,
        /// The batch the post before this page queued, for the message at the top.
        pub queued: Option<i32>,
    }

    #[route("/inventory-manager/count", post = count)]
    pub struct Count {
        #[route(query)]
        pub selection: Selection,
    }

    #[route("/inventory-manager/counts", post = save_counts)]
    pub struct SaveCounts {
        #[route(query)]
        pub selection: Selection,
    }

    #[route("/inventory-manager/clear", post = clear)]
    pub struct ClearCounts {
        #[route(query)]
        pub selection: Selection,
    }

    #[route("/inventory-manager/queue", post = queue_batch)]
    pub struct QueueBatch {
        #[route(query)]
        pub selection: Selection,
    }

    #[route("/inventory-manager/batches", get = batches)]
    pub struct Batches {
        #[route(query)]
        pub selection: Selection,
    }

    #[route("/inventory-manager/batches/{batch}/rate", post = change_rate)]
    pub struct ChangeRate {
        pub batch: i32,
        #[route(query)]
        pub selection: Selection,
    }

    /// What the screen shows: the product line and set, the search and where it looks, the
    /// product type and languages kept, and the condition counted. A missing value is the
    /// screen's default: Pokemon, its newest set, Near Mint, unsealed products.
    #[derive(Clone, Debug, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct Selection {
        pub line: Option<i32>,
        pub set: Option<i32>,
        pub scope: Option<Scope>,
        pub search: Option<String>,
        pub product_type: Option<ProductType>,
        #[serde(default)]
        pub language: Vec<String>,
        pub condition: Option<Condition>,
    }
}
