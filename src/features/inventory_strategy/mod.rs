//! Inventory Strategy: what the selling earned and how capital should turn over. Ported from
//! `app/features/inventory-strategy` slice by slice; the screen still renders in the React app
//! (`legacy::screens::InventoryStrategy`) until its views land here.
#![allow(dead_code, reason = "the domain lands before the screen that reads it")]
mod cache;
mod collate;
pub mod dashboard;
pub mod levers;
pub mod performance;
pub mod pricing_changes;
pub mod reinvestment;
pub mod selling_history;
pub mod snapshot;
pub mod sold_units;
pub mod strategy;
pub mod turnaround;
pub mod turnaround_settings;
pub mod verdict;

#[cfg(test)]
mod parity;
