//! The publication settings as the browser sends them. Switches are checkboxes; the automatic
//! sources share a name, so `automatic_sources` lists the ones switched on.
use corten::prelude::*;
use serde::Deserialize;

use super::config::{Settings, Source, range};

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct SettingsInput {
    #[serde(default)]
    pub global_paused: bool,
    pub consecutive_failure_limit: String,
    #[serde(default)]
    pub automatic_publishing_enabled: bool,
    #[serde(default)]
    pub automatic_sources: Vec<Source>,
    #[serde(default)]
    pub allow_warnings: bool,
    pub minimum_absolute_price_change: String,
    pub maximum_candidate_age_minutes: String,
    pub staged_micro_batch_maximum: String,
}

impl SettingsInput {
    /// The form filled with `settings`.
    pub fn of(settings: &Settings) -> Self {
        SettingsInput {
            global_paused: settings.global_paused,
            consecutive_failure_limit: settings.consecutive_failure_limit.to_string(),
            automatic_publishing_enabled: settings.automatic_publishing_enabled,
            automatic_sources: settings.automatic_sources.clone(),
            allow_warnings: settings.allow_warnings,
            minimum_absolute_price_change: settings.minimum_absolute_price_change.to_string(),
            maximum_candidate_age_minutes: settings.maximum_candidate_age_minutes.to_string(),
            staged_micro_batch_maximum: settings.staged_micro_batch_maximum.to_string(),
        }
    }

    /// The settings the form says, or which number is out of its range. The React app saved an
    /// out-of-range number as its default without saying so.
    pub fn read(&self) -> Result<Settings, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mut whole = |field, text: &str, range: std::ops::RangeInclusive<u32>| match text
            .trim()
            .parse::<u32>(
        ) {
            Ok(n) if range.contains(&n) => n,
            _ => {
                let (low, high) = range.into_inner();
                errors.add(field, format!("Enter a whole number from {low} to {high}."));
                low
            }
        };
        let consecutive_failure_limit = whole(
            f.consecutive_failure_limit,
            &self.consecutive_failure_limit,
            range::FAILURE_LIMIT,
        );
        let maximum_candidate_age_minutes = whole(
            f.maximum_candidate_age_minutes,
            &self.maximum_candidate_age_minutes,
            range::CANDIDATE_AGE_MINUTES,
        );
        let staged_micro_batch_maximum = whole(
            f.staged_micro_batch_maximum,
            &self.staged_micro_batch_maximum,
            range::MICRO_BATCH,
        );
        let minimum_absolute_price_change =
            match self.minimum_absolute_price_change.trim().parse::<f64>() {
                Ok(n) if range::PRICE_CHANGE.contains(&n) => n,
                _ => {
                    errors.add(
                        f.minimum_absolute_price_change,
                        "Enter an amount from 0 to 10000 dollars.",
                    );
                    0.0
                }
            };
        errors.into_result(Settings {
            global_paused: self.global_paused,
            consecutive_failure_limit,
            automatic_publishing_enabled: self.automatic_publishing_enabled,
            automatic_sources: Source::ALL
                .into_iter()
                .filter(|s| self.automatic_sources.contains(s))
                .collect(),
            allow_warnings: self.allow_warnings,
            maximum_candidate_age_minutes,
            minimum_absolute_price_change,
            staged_micro_batch_maximum,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_of_the_settings_reads_back_as_them() {
        let settings = Settings {
            automatic_sources: vec![Source::Continuous, Source::PendingInventory],
            minimum_absolute_price_change: 0.25,
            ..Settings::default()
        };
        let read = SettingsInput::of(&settings).read().unwrap();
        assert_eq!(
            read.automatic_sources,
            [Source::PendingInventory, Source::Continuous]
        );
        assert_eq!(read.minimum_absolute_price_change, 0.25);
    }

    #[test]
    fn a_number_out_of_range_is_named() {
        let input = SettingsInput {
            staged_micro_batch_maximum: "751".into(),
            minimum_absolute_price_change: "-1".into(),
            ..SettingsInput::of(&Settings::default())
        };
        let errors = input.read().unwrap_err();
        let f = SettingsInput::FIELDS;
        assert_eq!(
            errors.get(f.staged_micro_batch_maximum),
            Some("Enter a whole number from 1 to 750.")
        );
        assert!(errors.has(f.minimum_absolute_price_change));
        assert_eq!(errors.len(), 2);
    }
}
