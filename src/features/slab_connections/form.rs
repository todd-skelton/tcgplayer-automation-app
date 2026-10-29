//! A connection as the browser sends it: the pasted credential, and eBay's User-Agent.
use corten::prelude::*;
use serde::Deserialize;

use super::provider::{Credential, Provider, Refusal};

#[derive(Debug, Default, Deserialize, Fields)]
pub struct ConnectionInput {
    #[serde(default)]
    pub credential: String,
    /// Only eBay's form has it.
    #[serde(default)]
    pub user_agent: String,
}

impl ConnectionInput {
    pub fn read(&self, provider: Provider) -> Result<Credential, Errors> {
        let f = ConnectionInput::FIELDS;
        Credential::read(provider, &self.credential, &self.user_agent).map_err(|refusal| {
            let mut errors = Errors::new();
            match refusal {
                Refusal::Secret(message) => errors.add(f.credential, message),
                Refusal::UserAgent(message) => errors.add(f.user_agent, message),
            }
            errors
        })
    }
}
