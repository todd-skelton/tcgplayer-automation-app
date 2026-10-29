//! The settings form as the browser sends it, and the settings it says. The per-domain inputs
//! repeat once per domain under one name, in [`Domain::ALL`]'s order, so each is a list; the
//! adaptive switches are checkboxes whose value is their domain, so `adaptive` lists the domains
//! that have it on.
use corten::prelude::*;
use serde::Deserialize;

use super::config::{Adaptive, Domain, HttpConfig, Limits};

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct SettingsInput {
    pub tcg_auth_cookie: String,
    pub user_agent: String,
    pub increase_multiplier: String,
    pub floor_step_ms: String,
    pub decrease_amount_ms: String,
    pub success_threshold: String,
    #[serde(default)]
    pub domain: Vec<Domain>,
    #[serde(default)]
    pub request_delay_ms: Vec<String>,
    #[serde(default)]
    pub rate_limit_cooldown_ms: Vec<String>,
    #[serde(default)]
    pub max_concurrent_requests: Vec<String>,
    #[serde(default)]
    pub min_request_delay_ms: Vec<String>,
    #[serde(default)]
    pub max_request_delay_ms: Vec<String>,
    #[serde(default)]
    pub learned_min_delay_ms: Vec<String>,
    #[serde(default)]
    pub adaptive: Vec<Domain>,
}

/// One domain's row of the form, as text: what the inputs show.
pub struct DomainRow<'a> {
    pub domain: Domain,
    pub request_delay_ms: &'a str,
    pub rate_limit_cooldown_ms: &'a str,
    pub max_concurrent_requests: &'a str,
    pub min_request_delay_ms: &'a str,
    pub max_request_delay_ms: &'a str,
    pub learned_min_delay_ms: &'a str,
    pub adaptive: bool,
}

impl SettingsInput {
    /// The form filled with `config`.
    pub fn of(config: &HttpConfig) -> Self {
        let column = |f: fn(&Limits) -> u32| {
            config
                .domains
                .iter()
                .map(|(_, l)| f(l).to_string())
                .collect()
        };
        SettingsInput {
            tcg_auth_cookie: config.tcg_auth_cookie.clone(),
            user_agent: config.user_agent.clone(),
            increase_multiplier: config.adaptive.increase_multiplier.to_string(),
            floor_step_ms: config.adaptive.floor_step_ms.to_string(),
            decrease_amount_ms: config.adaptive.decrease_amount_ms.to_string(),
            success_threshold: config.adaptive.success_threshold.to_string(),
            domain: config.domains.iter().map(|(d, _)| *d).collect(),
            request_delay_ms: column(|l| l.request_delay_ms),
            rate_limit_cooldown_ms: column(|l| l.rate_limit_cooldown_ms),
            max_concurrent_requests: column(|l| l.max_concurrent_requests),
            min_request_delay_ms: column(|l| l.min_request_delay_ms),
            max_request_delay_ms: column(|l| l.max_request_delay_ms),
            learned_min_delay_ms: column(|l| l.learned_min_delay_ms),
            adaptive: config
                .domains
                .iter()
                .filter(|(_, l)| l.adaptive_enabled)
                .map(|(d, _)| *d)
                .collect(),
        }
    }

    /// The rows, one per domain the form sent, each with its own inputs' text.
    pub fn rows(&self) -> impl Iterator<Item = DomainRow<'_>> {
        self.domain
            .iter()
            .enumerate()
            .map(move |(i, &domain)| DomainRow {
                domain,
                request_delay_ms: at(&self.request_delay_ms, i),
                rate_limit_cooldown_ms: at(&self.rate_limit_cooldown_ms, i),
                max_concurrent_requests: at(&self.max_concurrent_requests, i),
                min_request_delay_ms: at(&self.min_request_delay_ms, i),
                max_request_delay_ms: at(&self.max_request_delay_ms, i),
                learned_min_delay_ms: at(&self.learned_min_delay_ms, i),
                adaptive: self.adaptive.contains(&domain),
            })
    }

    /// The settings the form says, or why it does not say any. Each repeated input has one name
    /// for every domain, so its error names the domain in the message (corten issue on per-row
    /// errors, filed by the port).
    pub fn read(&self) -> Result<HttpConfig, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mut whole = |field: FieldName, text: &str, what: &str, least: u32| -> u32 {
            match text.trim().parse::<u32>() {
                Ok(n) if n >= least => n,
                _ => {
                    errors.add(
                        field,
                        format!("{what} must be a whole number of at least {least}."),
                    );
                    0
                }
            }
        };
        let adaptive = Adaptive {
            increase_multiplier: 0.0,
            floor_step_ms: whole(f.floor_step_ms, &self.floor_step_ms, "The floor step", 10),
            decrease_amount_ms: whole(
                f.decrease_amount_ms,
                &self.decrease_amount_ms,
                "The decrease amount",
                10,
            ),
            success_threshold: whole(
                f.success_threshold,
                &self.success_threshold,
                "The success threshold",
                1,
            ),
        };
        let mut domains = Domain::ALL.map(|d| (d, d.default_limits()));
        for row in self.rows() {
            let name = row.domain.label();
            let limits = Limits {
                request_delay_ms: whole(
                    f.request_delay_ms,
                    row.request_delay_ms,
                    &format!("{name}: the request delay"),
                    0,
                ),
                rate_limit_cooldown_ms: whole(
                    f.rate_limit_cooldown_ms,
                    row.rate_limit_cooldown_ms,
                    &format!("{name}: the cooldown"),
                    0,
                ),
                max_concurrent_requests: whole(
                    f.max_concurrent_requests,
                    row.max_concurrent_requests,
                    &format!("{name}: the concurrent requests"),
                    1,
                ),
                adaptive_enabled: row.adaptive,
                min_request_delay_ms: whole(
                    f.min_request_delay_ms,
                    row.min_request_delay_ms,
                    &format!("{name}: the minimum delay"),
                    0,
                ),
                max_request_delay_ms: whole(
                    f.max_request_delay_ms,
                    row.max_request_delay_ms,
                    &format!("{name}: the maximum delay"),
                    1000,
                ),
                learned_min_delay_ms: whole(
                    f.learned_min_delay_ms,
                    row.learned_min_delay_ms,
                    &format!("{name}: the learned minimum delay"),
                    0,
                ),
            };
            if let Some(slot) = domains.iter_mut().find(|(d, _)| *d == row.domain) {
                slot.1 = limits;
            }
        }
        let increase_multiplier = match self.increase_multiplier.trim().parse::<f64>() {
            Ok(x) if (1.1..=5.0).contains(&x) => x,
            _ => {
                errors.add(
                    f.increase_multiplier,
                    "The increase multiplier must be a number from 1.1 to 5.",
                );
                0.0
            }
        };
        if self.domain.len() != Domain::ALL.len() {
            errors.add_form("The form did not send every domain; load the page again.");
        }
        let config = HttpConfig {
            tcg_auth_cookie: self.tcg_auth_cookie.trim().to_string(),
            user_agent: self.user_agent.trim().to_string(),
            domains,
            adaptive: Adaptive {
                increase_multiplier,
                ..adaptive
            },
        };
        errors.into_result(config)
    }
}

/// The `i`th value of a repeated input, or nothing when the form sent fewer.
fn at(column: &[String], i: usize) -> &str {
    column.get(i).map_or("", String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_of_a_config_reads_back_as_that_config() {
        let mut config = HttpConfig {
            tcg_auth_cookie: "ticket".into(),
            ..HttpConfig::default()
        };
        config.domains[6].1.request_delay_ms = 2500;
        config.domains[0].1.adaptive_enabled = false;
        assert_eq!(SettingsInput::of(&config).read().unwrap(), config);
    }

    #[test]
    fn a_zero_delay_stays_zero() {
        // The React action read `Number(value) || 1500`, so saving turned 0 ms into 1500 ms.
        let config = HttpConfig::default();
        assert_eq!(config.limits(Domain::MpApi).request_delay_ms, 0);
        assert_eq!(
            SettingsInput::of(&config)
                .read()
                .unwrap()
                .limits(Domain::MpApi)
                .request_delay_ms,
            0
        );
    }

    #[test]
    fn a_bad_number_names_its_domain() {
        let mut input = SettingsInput::of(&HttpConfig::default());
        input.max_concurrent_requests[6] = "0".into();
        let errors = input.read().unwrap_err();
        let message = errors
            .get(SettingsInput::FIELDS.max_concurrent_requests)
            .unwrap();
        assert!(message.starts_with("Seller Portal (store)"), "{message}");
    }
}
