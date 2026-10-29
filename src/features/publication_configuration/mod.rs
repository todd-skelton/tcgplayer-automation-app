//! Inventory Publication: whether batches and continuous pricing publish to Seller Portal by
//! themselves, the guardrails on what they publish, and the publisher's circuit breaker. Ported
//! from `app/features/inventory-publication/routes/publication-configuration.tsx`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /publication-configuration` | the settings and the publisher's state; `?done=` says what the last post did |
//! | `POST /publication-configuration` | the settings saved and the page loaded again, or the form with what is wrong |
//! | `POST /publication-configuration/resume` | the circuit closed and the failures forgotten |
mod config;
mod form;
mod page;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{resume, save, show};

#[corten::routes(area = PublicationSettings, state = crate::app::Shared)]
pub mod url {
    /// `done` is what the post before this page did, for the message at the top.
    #[route("/publication-configuration", get = show, post = save)]
    pub struct PublicationSettings {
        pub done: Option<super::views::Done>,
    }

    #[route("/publication-configuration/resume", post = resume)]
    pub struct ResumePublication;
}
