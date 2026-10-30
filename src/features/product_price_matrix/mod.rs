//! Product Price Matrix: one product's prices across its conditions and variants, and the refund
//! a condition dispute calls for. Ported from
//! `app/features/product-price-matrix/routes/product-price-matrix.tsx`.
//!
//! The products, their prices and the pricing policy stay the Node app's
//! (`/api/product-price-matrix/products` and `/api/product-price-matrix`). The choices are a GET
//! form, so a product, its language and whether it was priced by the policy are the page's
//! address: Refresh Market and Suggested Pricing are links, and a reload shows the same matrix.
//! The refund helper works in the browser from the prices the page drew, so changing a dispute
//! asks nothing of the server.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /product-price-matrix` | the choices in the query, and the chosen product's matrix |
mod matrix;
mod page;
mod products;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::show;

#[corten::routes(area = ProductPriceMatrix, state = crate::app::Shared)]
pub mod url {
    use crate::features::inventory_intake::catalog::{ProductType, Scope};

    #[route("/product-price-matrix", get = show)]
    pub struct ProductPriceMatrix {
        #[route(query)]
        pub choice: Choice,
    }

    /// What the page shows: the product line and set, or every set by card number (`number`);
    /// the product type offered, the product and its language; and whether the active policy's
    /// sell-at prices were asked for. `shown_product` is the product the form was drawn for, so
    /// a product chosen anew opens in its own language. A missing value is the screen's default:
    /// Pokemon, its newest set, unsealed products.
    #[derive(Clone, Debug, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct Choice {
        pub line: Option<i32>,
        pub set: Option<i32>,
        pub scope: Option<Scope>,
        pub number: Option<String>,
        pub product_type: Option<ProductType>,
        pub product: Option<i32>,
        pub shown_product: Option<i32>,
        pub language: Option<String>,
        pub suggested: Option<bool>,
    }
}
