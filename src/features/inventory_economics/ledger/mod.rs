//! The inventory-economics ledger: each order's proceeds, expenses and cost from the evidence
//! recorded about it, to the cent and with how much of it is known. Ported from the Node app's
//! `app/features/inventory-economics/domain` and `services/inventoryEconomics.server.ts`, whose
//! rounding it keeps exactly.
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
