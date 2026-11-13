//! The settings form as the browser sends it, and the settings it says. Each domain's inputs are
//! a row named by the domain (`domains[sellerPortal].request_delay_ms`), so a domain the browser
//! leaves out leaves the others where they are, and a bad number is marked on its own input.
use std::collections::BTreeMap;

use corten::prelude::*;

use super::config::{Adaptive, Domain, HttpConfig, Limits};

#[derive(Clone, Debug, Default, Fields)]
pub struct SettingsInput {
    pub tcg_auth_cookie: String,
    pub user_agent: String,
    pub increase_multiplier: Entry<f64>,
    pub floor_step_ms: Entry<u32>,
    pub decrease_amount_ms: Entry<u32>,
    pub success_threshold: Entry<u32>,
    #[fields(rows)]
    #[serde(default)]
    pub domains: BTreeMap<Domain, DomainInput>,
}

/// One domain's inputs, as typed: what they show.
#[derive(Clone, Debug, Default, Fields)]
pub struct DomainInput {
    pub request_delay_ms: Entry<u32>,
    pub rate_limit_cooldown_ms: Entry<u32>,
    pub max_concurrent_requests: Entry<u32>,
    pub min_request_delay_ms: Entry<u32>,
    pub max_request_delay_ms: Entry<u32>,
    pub learned_min_delay_ms: Entry<u32>,
    #[serde(default)]
    pub adaptive: bool,
}

impl DomainInput {
    fn of(limits: &Limits) -> Self {
        DomainInput {
            request_delay_ms: limits.request_delay_ms.into(),
            rate_limit_cooldown_ms: limits.rate_limit_cooldown_ms.into(),
            max_concurrent_requests: limits.max_concurrent_requests.into(),
            min_request_delay_ms: limits.min_request_delay_ms.into(),
            max_request_delay_ms: limits.max_request_delay_ms.into(),
            learned_min_delay_ms: limits.learned_min_delay_ms.into(),
            adaptive: limits.adaptive_enabled,
        }
    }
}

/// A whole number of at least `least`, or the field's error and 0.
fn whole_number<P: corten::form::Place>(
    errors: &mut Errors,
    field: FieldName<Entry<u32>, P>,
    entry: &Entry<u32>,
    what: &str,
    least: u32,
) -> u32 {
    match entry.value() {
        Some(n) if n >= least => n,
        _ => {
            errors.add(
                field,
                format!("{what} must be a whole number of at least {least}."),
            );
            0
        }
    }
}

impl SettingsInput {
    /// The form filled with `config`.
    pub fn of(config: &HttpConfig) -> Self {
        SettingsInput {
            tcg_auth_cookie: config.tcg_auth_cookie.clone(),
            user_agent: config.user_agent.clone(),
            increase_multiplier: config.adaptive.increase_multiplier.into(),
            floor_step_ms: config.adaptive.floor_step_ms.into(),
            decrease_amount_ms: config.adaptive.decrease_amount_ms.into(),
            success_threshold: config.adaptive.success_threshold.into(),
            domains: config
                .domains
                .iter()
                .map(|(d, l)| (*d, DomainInput::of(l)))
                .collect(),
        }
    }

    /// The settings the form says, or why it does not say any.
    pub fn read(&self) -> Result<HttpConfig, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mut whole = |field, entry: &Entry<u32>, what: &str, least: u32| {
            whole_number(&mut errors, field, entry, what, least)
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
        for (domain, row) in &self.domains {
            let r = f.domains.at(domain);
            let mut whole = |field, entry: &Entry<u32>, what: &str, least: u32| {
                whole_number(&mut errors, field, entry, what, least)
            };
            let limits = Limits {
                request_delay_ms: whole(
                    r.request_delay_ms,
                    &row.request_delay_ms,
                    "The request delay",
                    0,
                ),
                rate_limit_cooldown_ms: whole(
                    r.rate_limit_cooldown_ms,
                    &row.rate_limit_cooldown_ms,
                    "The cooldown",
                    0,
                ),
                max_concurrent_requests: whole(
                    r.max_concurrent_requests,
                    &row.max_concurrent_requests,
                    "The concurrent requests",
                    1,
                ),
                adaptive_enabled: row.adaptive,
                min_request_delay_ms: whole(
                    r.min_request_delay_ms,
                    &row.min_request_delay_ms,
                    "The minimum delay",
                    0,
                ),
                max_request_delay_ms: whole(
                    r.max_request_delay_ms,
                    &row.max_request_delay_ms,
                    "The maximum delay",
                    1000,
                ),
                learned_min_delay_ms: whole(
                    r.learned_min_delay_ms,
                    &row.learned_min_delay_ms,
                    "The learned minimum delay",
                    0,
                ),
            };
            if let Some(slot) = domains.iter_mut().find(|(d, _)| d == domain) {
                slot.1 = limits;
            }
        }
        let increase_multiplier = match self.increase_multiplier.value() {
            Some(x) if (1.1..=5.0).contains(&x) => x,
            _ => {
                errors.add(
                    f.increase_multiplier,
                    "The increase multiplier must be a number from 1.1 to 5.",
                );
                0.0
            }
        };
        if self.domains.len() != Domain::ALL.len() {
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
        // Zero is a delay of its own, not a blank to fill with the default.
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
    fn a_bad_number_is_its_domains_alone() {
        let mut input = SettingsInput::of(&HttpConfig::default());
        input
            .domains
            .get_mut(&Domain::SellerPortal)
            .unwrap()
            .max_concurrent_requests = Entry::typed("0");
        let errors = input.read().unwrap_err();
        let rows = SettingsInput::FIELDS.domains;
        assert_eq!(
            errors.get(rows.at(&Domain::SellerPortal).max_concurrent_requests),
            Some("The concurrent requests must be a whole number of at least 1.")
        );
        assert!(!errors.has(rows.at(&Domain::MpApi).max_concurrent_requests));
    }

    #[test]
    fn a_domain_is_read_from_its_own_names() {
        let body = "tcg_auth_cookie=&user_agent=ua&increase_multiplier=2&floor_step_ms=100\
            &decrease_amount_ms=100&success_threshold=10\
            &domains[sellerPortal].request_delay_ms=2500&domains[sellerPortal].rate_limit_cooldown_ms=1\
            &domains[sellerPortal].max_concurrent_requests=1&domains[sellerPortal].min_request_delay_ms=0\
            &domains[sellerPortal].max_request_delay_ms=1000&domains[sellerPortal].learned_min_delay_ms=0";
        let input: SettingsInput = corten::form::from_bytes(body.as_bytes()).unwrap();
        let row = &input.domains[&Domain::SellerPortal];
        assert_eq!(
            (row.request_delay_ms.text(), row.adaptive),
            (Some("2500"), false)
        );
        assert_eq!(input.domains.len(), 1);
    }
}
