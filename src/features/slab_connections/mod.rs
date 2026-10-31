//! Slab data connections: the signed-in sessions (Alt's token, eBay Research's cookie) the slab
//! pricer reads graded-card data with, saved without ever being shown, and a check that each still
//! reads. Ported from `app/features/ebay-slab-pricing/routes/slab-connections.tsx` and
//! `connections/`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /slab-connections` | each provider's connection and its status |
//! | `POST /slab-connections/{provider}` | the credential saved, unchecked; or the form with what is wrong |
//! | `POST /slab-connections/{provider}/check` | one read from the provider with it, and what that says |
//! | `POST /slab-connections/{provider}/remove` | the credential forgotten |
//!
//! Each post answers with the provider's card (`data-patch`), or the whole page without scripts.
mod access;
mod form;
mod page;
mod provider;
mod request;
mod store;
mod views;

pub use provider::Status as ConnectionStatus;
pub use request::Transport;
pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{check, remove, save, show};

#[corten::routes(area = SlabConnections, state = crate::app::Shared)]
pub mod url {
    use super::provider::Provider;

    #[route("/slab-connections", get = show)]
    pub struct SlabConnections;

    #[route("/slab-connections/{provider}", post = save)]
    pub struct SaveConnection {
        pub provider: Provider,
    }

    #[route("/slab-connections/{provider}/check", post = check)]
    pub struct CheckConnection {
        pub provider: Provider,
    }

    #[route("/slab-connections/{provider}/remove", post = remove)]
    pub struct RemoveConnection {
        pub provider: Provider,
    }
}
