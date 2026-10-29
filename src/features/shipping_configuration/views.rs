//! The Shipping Configuration screen. Its stylesheet is next to it in `views/`.
use corten::{Component, UrlValue};
use serde::Deserialize;

mod shipping_screen;

pub use shipping_screen::{ShippingScreen, ShippingSettingsForm};

/// `ShippingSettingsForm` holds the stylesheet the screen shares.
pub const COMPONENTS: &[Component] = &[ShippingSettingsForm];

/// What the last post did, for the message at the top of the page it was sent back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Saved,
    Reset,
}
