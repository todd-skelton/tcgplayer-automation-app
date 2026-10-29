//! The Slab data connections screen: a card per provider. Its stylesheet is next to it in
//! `views/`.
use corten::{Component, prelude::Errors};

use super::provider::{Provider, Status};
use crate::layout::Tone;

mod connection_card;

pub use connection_card::{ConnectionCard, ConnectionsScreen};

/// `ConnectionCard` holds the stylesheet.
pub const COMPONENTS: &[Component] = &[ConnectionCard];

/// What a post to a connection did, said on its card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Saved,
    Removed,
    /// What one read from the provider found.
    Checked(Status),
}

impl Outcome {
    fn message(self) -> &'static str {
        match self {
            Outcome::Saved => Status::Unchecked.message(),
            Outcome::Removed => "Connection removed.",
            Outcome::Checked(found) => found.message(),
        }
    }

    fn tone(self) -> Tone {
        match self {
            Outcome::Saved | Outcome::Removed | Outcome::Checked(Status::Connected) => Tone::Done,
            Outcome::Checked(_) => Tone::Warning,
        }
    }
}

/// The post a card answers: what it did, or what is wrong with the form, and the User-Agent the
/// user typed. Only that provider's card shows it.
pub struct Answered<'a> {
    pub provider: Provider,
    pub outcome: Option<Outcome>,
    pub errors: &'a Errors,
    pub user_agent: &'a str,
}
