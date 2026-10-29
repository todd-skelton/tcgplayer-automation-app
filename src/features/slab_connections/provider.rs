//! The slab data providers, what is known of each saved connection, and the rules a credential
//! meets before it is saved. Ported from `connections/providerConnection.ts` and
//! `validateCredential` in `connections/providerConnections.server.ts`.
use chrono::{DateTime, Utc};
use corten::UrlValue;
use serde::Deserialize;

/// A source of graded-card data reached with the user's own signed-in session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Alt,
    EbayResearch,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Alt, Provider::EbayResearch];

    pub fn name(self) -> &'static str {
        match self {
            Provider::Alt => "Alt",
            Provider::EbayResearch => "eBay Product Research",
        }
    }
}

/// What the last save or access check left a connection in, as `slab_provider_connections.status`
/// stores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    NotConfigured,
    Unchecked,
    Connected,
    ReconnectRequired,
    Busy,
    RateLimited,
    Unavailable,
    InvalidResponse,
    Cancelled,
}

impl Status {
    const ALL: [Status; 9] = [
        Status::NotConfigured,
        Status::Unchecked,
        Status::Connected,
        Status::ReconnectRequired,
        Status::Busy,
        Status::RateLimited,
        Status::Unavailable,
        Status::InvalidResponse,
        Status::Cancelled,
    ];

    /// The stored word for a status; a word this app does not know reads as unchecked.
    pub fn stored(word: &str) -> Status {
        Status::ALL
            .into_iter()
            .find(|status| status.as_ref() == word)
            .unwrap_or(Status::Unchecked)
    }

    /// What the screen says about a connection in this status.
    pub fn message(self) -> &'static str {
        match self {
            Status::NotConfigured => "Add a connection to check access.",
            Status::Unchecked => "Connection saved. Check access to verify it.",
            Status::Connected => "Connection verified.",
            Status::ReconnectRequired => {
                "Sign in to the provider and replace the saved connection."
            }
            Status::Busy => {
                "Another request is running or this provider is cooling down. Try again shortly."
            }
            Status::RateLimited => "The provider asked us to wait. Try again after its cooldown.",
            Status::Unavailable => "The provider is temporarily unavailable. Try again shortly.",
            Status::InvalidResponse => {
                "The provider returned an unexpected response. The adapter may need updating."
            }
            Status::Cancelled => "Connection check cancelled or timed out.",
        }
    }
}

/// A provider's saved connection, without its credential: the screen never shows it.
#[derive(Clone, Debug)]
pub struct Connection {
    pub provider: Provider,
    pub configured: bool,
    pub status: Status,
    pub checked_at: Option<DateTime<Utc>>,
}

impl Connection {
    pub fn none(provider: Provider) -> Self {
        Connection {
            provider,
            configured: false,
            status: Status::NotConfigured,
            checked_at: None,
        }
    }
}

/// A credential that meets its provider's rules, ready to save: Alt's bearer token without its
/// `Bearer ` prefix, or eBay's Cookie header with the browser's User-Agent.
#[derive(Debug, PartialEq, Eq)]
pub struct Credential {
    pub secret: String,
    pub user_agent: String,
}

/// Why a credential cannot be saved, by the field to fix.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Secret(&'static str),
    UserAgent(&'static str),
}

const MAX_SECRET: usize = 32_768;
const MAX_USER_AGENT: usize = 512;

impl Credential {
    /// Reads what the user pasted. Line breaks are refused in both fields: each goes into a
    /// request header.
    pub fn read(provider: Provider, secret: &str, user_agent: &str) -> Result<Self, Refusal> {
        let secret = match provider {
            Provider::Alt => strip_bearer(secret.trim()),
            Provider::EbayResearch => secret.trim(),
        };
        if secret.is_empty() || secret.chars().count() > MAX_SECRET || has_line_break(secret) {
            return Err(Refusal::Secret(match provider {
                Provider::Alt => "Paste the authorization token, on one line.",
                Provider::EbayResearch => "Paste the Cookie header, on one line.",
            }));
        }
        if user_agent.chars().count() > MAX_USER_AGENT || has_line_break(user_agent) {
            return Err(Refusal::UserAgent(
                "Paste the User-Agent on one line, 512 characters at most.",
            ));
        }
        match provider {
            Provider::Alt => {
                let token = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
                if !secret.chars().all(token) {
                    return Err(Refusal::Secret(
                        "An Alt token has only letters, digits, dots, dashes and underscores.",
                    ));
                }
                Ok(Credential {
                    secret: secret.to_owned(),
                    user_agent: String::new(),
                })
            }
            Provider::EbayResearch => {
                if !secret.contains('=') {
                    return Err(Refusal::Secret(
                        "A Cookie header is name=value pairs separated by semicolons.",
                    ));
                }
                if user_agent.trim().is_empty() {
                    return Err(Refusal::UserAgent(
                        "Paste the User-Agent of the browser signed in to eBay.",
                    ));
                }
                Ok(Credential {
                    secret: secret.to_owned(),
                    user_agent: user_agent.trim().to_owned(),
                })
            }
        }
    }
}

fn strip_bearer(token: &str) -> &str {
    match token.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("bearer ") => token[7..].trim_start(),
        _ => token,
    }
}

fn has_line_break(text: &str) -> bool {
    text.contains(['\r', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_alt_token_loses_its_bearer_prefix() {
        let read = Credential::read(Provider::Alt, "  Bearer token.value ", "");
        assert_eq!(read.map(|c| c.secret), Ok("token.value".to_owned()));
    }

    #[test]
    fn a_header_with_a_line_break_is_refused() {
        let read = Credential::read(
            Provider::EbayResearch,
            "cookie=value\r\nInjected: true",
            "agent",
        );
        assert!(matches!(read, Err(Refusal::Secret(_))));
    }

    #[test]
    fn ebay_needs_the_browser_user_agent() {
        let read = Credential::read(Provider::EbayResearch, "cookie=value", " ");
        assert!(matches!(read, Err(Refusal::UserAgent(_))));
        let read = Credential::read(Provider::EbayResearch, "cookie=value", " agent ");
        assert_eq!(read.map(|c| c.user_agent), Ok("agent".to_owned()));
    }

    #[test]
    fn an_alt_token_is_one_word() {
        assert!(Credential::read(Provider::Alt, "token value", "").is_err());
    }

    #[test]
    fn an_unknown_stored_status_reads_as_unchecked() {
        assert_eq!(
            Status::stored("reconnect-required"),
            Status::ReconnectRequired
        );
        assert_eq!(Status::stored("someday"), Status::Unchecked);
    }
}
