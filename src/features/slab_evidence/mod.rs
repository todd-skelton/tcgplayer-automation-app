//! Slab evidence: what is read from Alt and eBay for a graded card (sales, a sale's detail, the
//! asks on unsold listings), each request kept under a key with the refresh that fetches it. Ported
//! from the Node app's `ebay-slab-pricing/evidence`.
//!
//! [`spec`] says what a request is and the key it is kept under; [`store`] is the refresh queue a
//! worker claims from, and where what it fetched is saved; [`worker`] reads and saves each.
pub mod spec;
pub mod store;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "run once reading Alt and eBay is ported")
)]
pub mod worker;
