//! First-in, first-out matching of each sold line to the stock that was on hand for it, ported
//! from the Node app's `inventory-fifo` feature and its replay in the seller order history worker.
//! Node still records the matches; this computes the same ones beside it until the two agree.
pub mod allocate;
pub mod replay;
pub mod shadow;
