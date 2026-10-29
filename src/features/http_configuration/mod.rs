//! HTTP Configuration: TCGplayer's auth cookie, the user agent, and how fast the workers may call
//! each TCGplayer API. Ported from `app/routes/http-configuration.tsx`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /http-configuration` | the settings form; `?done=saved` or `?done=reset` says what the last post did |
//! | `POST /http-configuration` | the settings saved and the page loaded again, or the form with what is wrong |
//! | `POST /http-configuration/reset` | every setting back to its default, the auth cookie cleared |
mod config;
mod form;
mod page;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{reset, save, show};

#[corten::routes(area = HttpSettings, state = crate::app::Shared)]
pub mod url {
    /// `done` is what the post before this page did, for the message at the top.
    #[route("/http-configuration", get = show, post = save)]
    pub struct HttpSettings {
        pub done: Option<super::views::Done>,
    }

    #[route("/http-configuration/reset", post = reset)]
    pub struct ResetSettings;
}
