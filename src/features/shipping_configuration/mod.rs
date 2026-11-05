//! Shipping Configuration: the sender, the package sizes and limits, and the label defaults the
//! shipping export builds EasyPost shipments from. Ported from
//! `app/features/shipping-export/routes/shipping-configuration.tsx`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /shipping-configuration` | the settings form; the layout's toaster says what the last post did |
//! | `POST /shipping-configuration` | the settings saved and the page loaded again, or the form with what is wrong |
//! | `POST /shipping-configuration/reset` | every setting back to its default |
mod config;
mod form;
mod page;
mod views;

pub use views::COMPONENTS;

pub use config::{Address, EasyPostMode, LabelFormat, LabelSize, Package, Service, ShippingConfig};
pub use form::measure_text;

/// The saved settings, each key a row lacks at its default.
pub async fn settings(db: &crate::database::Database) -> sqlx::Result<ShippingConfig> {
    config::load(db).await
}

/// The seller the shop ships and publishes for, or empty when none is set.
pub async fn default_seller_key(db: &crate::database::Database) -> sqlx::Result<String> {
    Ok(config::load(db).await?.default_seller_key)
}

// Handlers are named from here, where the routes module is declared.
use page::{reset, save, show};

#[corten::routes(area = ShippingSettings, state = crate::app::Shared)]
pub mod url {
    #[route("/shipping-configuration", get = show, post = save)]
    pub struct ShippingSettings;

    #[route("/shipping-configuration/reset", post = reset)]
    pub struct ResetShippingSettings;
}
