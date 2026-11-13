//! First-in, first-out matching of each sold line to the stock that was on hand for it
//! (`inventory-fifo`), replayed by the seller order history worker ([`queue`]); [`shadow`]
//! compares a replay with the revisions saved.
pub mod allocate;
pub mod queue;
pub mod replay;
pub mod shadow;
