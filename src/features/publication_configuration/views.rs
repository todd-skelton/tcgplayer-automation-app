//! The Inventory Publication screen. Its stylesheet is next to it in `views/`.
use corten::{Component, UrlValue};
use serde::Deserialize;

mod publication_screen;

pub use publication_screen::{PublicationForm, PublicationScreen};

/// `PublicationForm` holds the stylesheet the screen shares.
pub const COMPONENTS: &[Component] = &[PublicationForm];

/// What the last post did, for the message at the top of the page it was sent back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Saved,
    Resumed,
}
