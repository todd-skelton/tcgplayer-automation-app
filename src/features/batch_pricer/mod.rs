//! Batch Pricer: make a batch from a CSV export or a seller's live inventory, price it, follow
//! its pricing as it runs, download its results, publish what is ready to Seller Portal, or delete
//! it. Ported from `app/features/pending-inventory/routes/pending-inventory-pricer.tsx`.
//!
//! The batches, their pricing and their publication are the Node app's (its workers do the work),
//! so every read and write goes through its `/api/inventory-batches` routes. While a batch prices
//! or publishes, a `<corten-live>` stream follows it and sends the batch's panel each time it
//! changes, as the React screen's event stream did; a browser without scripts reads the page
//! again instead.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /pending-inventory-pricer` | the screen for `?batch=`, or the newest batch |
//! | `POST /pending-inventory-pricer/import-csv` | a batch made from a CSV export |
//! | `POST /pending-inventory-pricer/import-seller` | a batch made from a seller's live inventory |
//! | `POST /pending-inventory-pricer/batches/{batch}/price` | pricing queued, every SKU or the errors |
//! | `GET /pending-inventory-pricer/batches/{batch}/live` | the batch's panel each time it changes, while it prices or publishes |
//! | `GET /pending-inventory-pricer/batches/{batch}/results` | its successful or manual-review rows as CSV |
//! | `POST /pending-inventory-pricer/batches/{batch}/publish` | the selected SKUs planned for publication |
//! | `POST /pending-inventory-pricer/batches/{batch}/delete` | the batch deleted |
//!
//! The React screen remembered the seller key typed last in the browser; this one starts from
//! the shipping settings' default seller. Dates are written in the visitor's time zone, which the
//! browser names after its first page (`App::client_zone`); until then they are in UTC.
mod batches;
mod page;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{delete, download, import_csv, import_seller, live, price, publish, show};

#[corten::routes(area = BatchPricer, state = crate::app::Shared)]
pub mod url {
    use super::{batches::Scope, page::Chosen};

    /// `chosen` is the batch shown, the newest when none.
    #[route("/pending-inventory-pricer", get = show)]
    pub struct BatchPricer {
        #[route(query)]
        pub chosen: Chosen,
    }

    #[route("/pending-inventory-pricer/import-csv", post = import_csv)]
    pub struct ImportCsv;

    #[route("/pending-inventory-pricer/import-seller", post = import_seller)]
    pub struct ImportSeller;

    #[route("/pending-inventory-pricer/batches/{batch}/price", post = price)]
    pub struct Price {
        pub batch: i32,
    }

    #[route("/pending-inventory-pricer/batches/{batch}/live", get = live)]
    pub struct Live {
        pub batch: i32,
    }

    #[route("/pending-inventory-pricer/batches/{batch}/results", get = download)]
    pub struct Results {
        pub batch: i32,
        pub scope: Scope,
    }

    #[route("/pending-inventory-pricer/batches/{batch}/publish", post = publish)]
    pub struct Publish {
        pub batch: i32,
    }

    #[route("/pending-inventory-pricer/batches/{batch}/delete", post = delete)]
    pub struct Delete {
        pub batch: i32,
    }
}
