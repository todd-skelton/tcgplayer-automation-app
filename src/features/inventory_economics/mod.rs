//! Inventory Economics: what each captured order sold for, what it cost to buy and send, and
//! what it left to reinvest, with the purchase costs that price the inventory. Ported from
//! `app/features/inventory-economics/routes/inventory-economics.tsx`.
//!
//! The ledger and its arithmetic stay the Node app's (`GET /api/inventory-economics`, which
//! reads the default shipping seller's workspace); this screen only shows it.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /inventory-economics` | the seller's current purchase costs and each order's economics |
mod page;
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
