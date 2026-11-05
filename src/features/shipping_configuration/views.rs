//! The Shipping Configuration screen. Its stylesheet is next to it in `views/`.
use corten::Component;

mod shipping_screen;

pub use shipping_screen::{ShippingScreen, ShippingSettingsForm};

/// `ShippingSettingsForm` holds the stylesheet the screen shares.
pub const COMPONENTS: &[Component] = &[ShippingSettingsForm];
