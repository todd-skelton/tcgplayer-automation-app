//! The seller's order history from TCGplayer's order management API, ported from the Node app's
//! `seller-order-history` feature and its worker. Node still records the history; this reads the
//! same orders beside it and says where it would record something else, until the two agree.
pub mod api;
#[cfg(test)]
mod fixtures;
pub mod observation;
pub mod shadow;
pub mod sync;
