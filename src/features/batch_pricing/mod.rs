//! Inventory batch pricing, the pricing worker's job: a batch's items priced from their latest
//! sales and written as the rows and details the Batch Pricer shows. Ported from
//! `inventoryBatchPricing.server.ts` and `inventoryBatchPricingWorker.server.ts`.
//!
//! Node's worker owns the jobs until cutover (port decision 26). The port's worker
//! ([`worker::start`]) claims from the same queue only when `PRICING_WORKER` is set.
pub mod cache;
pub mod imported;
pub mod job;
pub mod jobs;
pub mod market;
pub mod queue;
pub mod results;
pub mod save;
pub mod saved_curves;
pub mod shadow;
pub mod worker;
