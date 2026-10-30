//! The pricing engine shared by the batch pricer, continuous pricing and Inventory Strategy: how
//! value grows with the time a listing waits, and what that does to return on capital. Ported from
//! `app/features/pricing/domain` with its tests.
#![allow(
    dead_code,
    reason = "the engine lands before the pricers and the strategy screen that call it"
)]
pub mod capital_cycle;
pub mod horizon_value_curve;
pub mod maximize;
