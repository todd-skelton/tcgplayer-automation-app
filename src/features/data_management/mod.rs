//! Data Management: the jobs that refresh the local TCGplayer catalog (product lines, a product
//! line's new products or every product, one product, one set), each a form whose result shows
//! under it. Ported from `app/routes/home.tsx` (served at `/data-management`).
//!
//! The jobs stay the Node app's (`/api/data-management`, which runs the React form's action):
//! they read TCGplayer and write the catalog. This screen checks what each form says, asks for
//! the job, and draws what it did. With JavaScript a form's answer replaces its card only, so the
//! other forms keep what was typed; without, it is the page with that card's result.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /data-management` | the five forms, each with the product lines to choose from |
//! | `POST /data-management/product-lines` | the product lines read again |
//! | `POST /data-management/new-products` | a product line's changed sets read again |
//! | `POST /data-management/product-line` | every product of a product line checked |
//! | `POST /data-management/product` | one product and its SKUs read again |
//! | `POST /data-management/set` | one set's products and SKUs read, optionally from scratch |
//!
//! A form that is not filled in is a 422 with what is missing. A job the Node app refuses keeps
//! its status (a product it does not know is a 404); one that fails is a 502.
mod actions;
mod jobs;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use actions::{
    check_product_line, hydrate_set, refresh_product_lines, repair_product, show, sync_new_products,
};

#[corten::routes(area = DataManagement, state = crate::app::Shared)]
pub mod url {
    #[route("/data-management", get = show)]
    pub struct DataManagement;

    #[route("/data-management/product-lines", post = refresh_product_lines)]
    pub struct RefreshProductLines;

    #[route("/data-management/new-products", post = sync_new_products)]
    pub struct SyncNewProducts;

    #[route("/data-management/product-line", post = check_product_line)]
    pub struct CheckProductLine;

    #[route("/data-management/product", post = repair_product)]
    pub struct RepairProduct;

    #[route("/data-management/set", post = hydrate_set)]
    pub struct HydrateSet;
}
