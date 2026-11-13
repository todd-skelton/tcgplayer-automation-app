//! The seller's order history from TCGplayer's order management API (`seller-order-history`),
//! recorded by its worker; the shadow reads the same orders beside the history and says where it
//! would record something else. An order export a user imports is recorded here
//! (`file_import`), and so is a step of the scan the shipping workflow asks for (`catch_up`).
pub mod api;
pub mod catch_up;
pub mod file_import;
#[cfg(test)]
mod fixtures;
pub mod observation;
pub mod shadow;
pub mod store;
pub mod sync;
pub mod worker;
