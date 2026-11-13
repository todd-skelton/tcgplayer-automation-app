//! Inventory Manager: count cards into inventory, set by set, a condition at a time, from the
//! keyboard. Ported from `app/features/inventory-management/routes/inventory-manager.tsx`.
//!
//! The filters are a GET form, so a set, a search or a product line is a link, and the server
//! searches and pages a set without JavaScript. With it, the page brings the whole set once and
//! the script searches, sorts and pages it, and draws another condition's counts, with no
//! request; only a card number searched across every set goes to the
//! server. The GET form is `data-patch` too: another set, product line or filter is answered with
//! the parts that change with it and the products it keeps, read without the counts or the
//! batches, which the browser keeps a few minutes, so a set seen again comes with no request. The
//! script draws the rows from them with the counts it holds and puts the set's address in the
//! history. Each count is its own form: the script writes the new count into its field and submits
//! it, and a change made while one is on its way waits for that answer, then goes with the latest
//! count (the runtime's order for a `data-patch` write). Without JavaScript, Enter in a field
//! sends it.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-manager` | the screen for the filters in the query; with JavaScript, what changes with them |
//! | `POST /inventory-manager/count` | one SKU's count set: its form and the totals |
//! | `POST /inventory-manager/clear` | every count not yet queued removed: the totals and the counts |
//! | `POST /inventory-manager/queue` | the counts queued as a pricing batch |
//! | `GET /inventory-manager/batches` | the background batches again, read every 5 seconds |
//! | `POST /inventory-manager/batches/{batch}/rate` | a queued batch estimated at another rate |
//!
//! An unconfirmed queue request is not kept in the browser to send again after a reload: the
//! form's submit key is the request id, and a reload shows what happened: the batch in the
//! background batches and the counts gone, or the counts still there.
pub(crate) mod catalog;
mod page;
mod pending;
pub mod queue;
mod views;

pub use views::COMPONENTS;
#[cfg(test)]
pub use views::{IntakeCounts, IntakeListing};

// Handlers are named from here, where the routes module is declared.
use page::{batches, change_rate, clear, count, queue_batch, show};

#[corten::routes(area = InventoryManager, state = crate::app::Shared)]
pub mod url {
    use super::catalog::{Condition, ProductType, Scope};

    #[route("/inventory-manager", get = show)]
    pub struct InventoryManager {
        #[route(query)]
        pub selection: Selection,
    }

    /// The SKU is in the form, so every count form on the screen posts to the same address and
    /// the script makes one for any SKU from the same template.
    #[route("/inventory-manager/count", post = count)]
    pub struct Count {
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
    /// product type and languages kept, the condition counted, and the page of products. A
    /// missing value is the screen's default: Pokemon, its newest set, Near Mint, unsealed
    /// products, the first page of 100. The filters send no page, so a new filter starts on the
    /// first.
    #[derive(Clone, Debug, Default, corten::Route, corten::Fields)]
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
        pub page: Option<usize>,
        pub rows: Option<super::catalog::PageSize>,
        /// The products' order: by name, A to Z, when none.
        pub sort: Option<super::catalog::ProductOrder>,
    }
}
