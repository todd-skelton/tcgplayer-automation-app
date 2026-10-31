//! Publishing priced batches to Seller Portal: which priced SKUs may be published, the publication
//! a batch plans, and (once ported) the worker that publishes it. Ported from
//! `app/features/inventory-publication`. The Node app publishes until cutover (port decision 3), so
//! this plans only what the Rust pricing worker would hand it.
#![allow(
    dead_code,
    reason = "planning lands before the pricing worker that calls it"
)]
pub mod plan;
pub mod policy;
pub mod preview;
