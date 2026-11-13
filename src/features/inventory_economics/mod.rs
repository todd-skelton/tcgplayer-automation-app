//! Inventory Economics: what each captured order sold for, what it cost to buy and send, and
//! what it left to reinvest, with the purchase costs that price the inventory. Ported from
//! `app/features/inventory-economics/routes/inventory-economics.tsx`.
//!
//! The ledger is computed here (`ledger`, with the rounding its recorded figures were made with)
//! for the default shipping seller's most recent hundred orders.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-economics` | the seller's current purchase costs and each order's economics |
pub mod details;
pub mod estimate;
pub mod ledger;
mod page;
pub mod purchase_cost;
pub mod series;
mod views;
mod workspace;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::show;

#[corten::routes(area = InventoryEconomics, state = crate::app::Shared)]
pub mod url {
    #[route("/inventory-economics", get = show)]
    pub struct InventoryEconomics;
}
