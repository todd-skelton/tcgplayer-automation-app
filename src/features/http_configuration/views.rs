//! The HTTP Configuration screen. Its stylesheet and script are next to it in `views/`.
use corten::Component;

mod settings_screen;

pub use settings_screen::{SettingsForm, SettingsScreen};

/// `SettingsForm` holds the stylesheet the screen shares and the script.
pub const COMPONENTS: &[Component] = &[SettingsForm];
