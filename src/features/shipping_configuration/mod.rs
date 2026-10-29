//! Shipping Configuration: the sender, the package sizes and limits, and the label defaults the
//! shipping export builds EasyPost shipments from. Ported from
//! `app/features/shipping-export/routes/shipping-configuration.tsx`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /shipping-configuration` | the settings form; `?done=saved` or `?done=reset` says what the last post did |
//! | `POST /shipping-configuration` | the settings saved and the page loaded again, or the form with what is wrong |
//! | `POST /shipping-configuration/reset` | every setting back to its default |
mod config;
mod form;
mod page;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{reset, save, show};

#[corten::routes(area = ShippingSettings, state = crate::app::Shared)]
pub mod url {
    /// `done` is what the post before this page did, for the message at the top.
    #[route("/shipping-configuration", get = show, post = save)]
    pub struct ShippingSettings {
        pub done: Option<super::views::Done>,
    }

    #[route("/shipping-configuration/reset", post = reset)]
    pub struct ResetShippingSettings;
}
