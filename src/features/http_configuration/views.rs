//! The HTTP Configuration screen. Its stylesheet and script are next to it in `views/`.
use corten::{Component, UrlValue};
use serde::Deserialize;

mod settings_screen;

pub use settings_screen::{SettingsForm, SettingsScreen};

/// `SettingsForm` holds the stylesheet the screen shares and the script.
pub const COMPONENTS: &[Component] = &[SettingsForm];

/// What the last post did, for the message at the top of the page it was sent back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Saved,
    Reset,
}
