//! Inventory Publication: whether batches and continuous pricing publish to Seller Portal by
//! themselves, the guardrails on what they publish, and the publisher's circuit breaker. Ported
//! from `app/features/inventory-publication/routes/publication-configuration.tsx`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /publication-configuration` | the settings and the publisher's state; the layout's toaster says what the last post did |
//! | `POST /publication-configuration` | the settings saved and the page loaded again, or the form with what is wrong |
//! | `POST /publication-configuration/resume` | the circuit closed and the failures forgotten |
mod config;
mod form;
mod page;
mod views;

pub use views::COMPONENTS;

/// Whether publication is stopped: paused by hand, or its circuit open or its sign-in refused
/// until someone resumes it.
pub async fn paused(db: &crate::database::Database) -> sqlx::Result<bool> {
    let (settings, runtime) = config::load(db).await?;
    Ok(settings.global_paused || runtime.needs_resume())
}

// Handlers are named from here, where the routes module is declared.
use page::{resume, save, show};

#[corten::routes(area = PublicationSettings, state = crate::app::Shared)]
pub mod url {
    #[route("/publication-configuration", get = show, post = save)]
    pub struct PublicationSettings;

    #[route("/publication-configuration/resume", post = resume)]
    pub struct ResumePublication;
}
