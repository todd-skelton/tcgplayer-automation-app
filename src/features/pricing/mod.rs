//! The pricing engine shared by the batch pricer, continuous pricing and Inventory Strategy: how
//! value grows with the time a listing waits, and what that does to return on capital. Ported from
//! `app/features/pricing/domain` with its tests.
#![allow(
    dead_code,
    reason = "the engine lands before the pricers and the strategy screen that call it"
)]
pub mod buyer_arrival_rate;
pub mod buyer_choice_sell_time;
pub mod calculator;
pub mod capital_cycle;
pub mod condition_normalization;
pub mod condition_sale_rate;
pub mod effective_sale_price;
pub mod horizon_value_curve;
pub mod latest_sales_price;
pub mod marketplace_price;
pub mod maximize;
pub mod policy;
pub mod sale;
pub mod shipping_threshold_snap;
pub mod sku_price;
pub mod supply_analysis;
