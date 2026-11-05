//! The Inventory Publication screen. Its stylesheet is next to it in `views/`.
use corten::Component;

mod publication_screen;

pub use publication_screen::{PublicationForm, PublicationScreen};

/// `PublicationForm` holds the stylesheet the screen shares.
pub const COMPONENTS: &[Component] = &[PublicationForm];
