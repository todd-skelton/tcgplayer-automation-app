//! Slab evidence: what is read from Alt and eBay for a graded card (sales, a sale's detail, the
//! asks on unsold listings), each request kept under a key with the refresh that fetches it. Ported
//! from the Node app's `ebay-slab-pricing/evidence`.
//!
//! [`alt`] and [`ebay`] read the providers' evidence. [`spec`] says what a request is and the key it is kept under; [`store`] is the refresh queue a
//! worker claims from, and where what it fetched is saved, a supply refresh's listings as a
//! [`supply`] scan; [`worker`] reads and saves each.
pub mod alt;
pub mod ebay;
pub mod spec;
pub mod store;
pub mod supply;
pub mod worker;
