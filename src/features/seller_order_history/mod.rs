//! The seller's order history from TCGplayer's order management API, ported from the Node app's
//! `seller-order-history` feature and its worker. Node still records the API's history; this
//! reads the same orders beside it and says where it would record something else, until the two
//! agree. An order export a user imports is recorded here (`file_import`).
pub mod api;
pub mod file_import;
#[cfg(test)]
mod fixtures;
pub mod observation;
pub mod shadow;
pub mod store;
pub mod sync;
pub mod worker;
