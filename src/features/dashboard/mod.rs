//! The home page: a card for each screen, with what it is for. Ported from
//! `app/routes/dashboard.tsx`, which drew `primaryNavigationItems`; here the same list as the
//! app bar's, [`crate::layout::PRIMARY`].
//!
//! `GET /` is the app's own route (`crate::app::url::Home`): an area cannot sit at the root,
//! and every other path there is the React app's.
mod page;

pub use page::{COMPONENTS, show};
