//! Inventory batch pricing, the pricing worker's job: a batch's items priced from their latest
//! sales and written as the rows and details the Batch Pricer shows. Ported from
//! `inventoryBatchPricing.server.ts` and `inventoryBatchPricingWorker.server.ts`.
//!
//! While Node's worker owns the jobs (port decision 26), this runs as a shadow beside it: it prices
//! the batches Node priced and logs where its results differ, writing nothing.
#![allow(
    dead_code,
    reason = "the job lands before the worker that claims and saves it"
)]
pub mod cache;
pub mod job;
pub mod results;
pub mod shadow;
