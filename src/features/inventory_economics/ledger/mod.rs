//! The inventory-economics ledger: each order's proceeds, expenses and cost from the evidence
//! recorded about it, to the cent and with how much of it is known, rounded exactly as the
//! recorded figures were (`inventory-economics/domain`, `inventoryEconomics.server.ts`).
pub mod assumptions;
pub mod evidence;
pub mod fingerprint;
pub mod money;
pub mod order;
pub mod orders;
pub mod postage;
#[allow(
    dead_code,
    reason = "Inventory Strategy's reinvestment reads it; ported next"
)]
pub mod proceeds;
