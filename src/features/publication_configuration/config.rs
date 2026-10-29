//! The publication settings this screen edits, and the publisher's runtime state, as
//! `inventory_publication_settings` stores them. Ported from
//! `core/db/repositories/inventoryPublicationSettings.server.ts` and
//! `services/inventoryPublicationSettings.ts`.
//!
//! `settings_json` also holds settings other screens own (`continuousPricing`, and policy values
//! with no field here). A save merges only this screen's keys into it, in one statement, so it
//! never writes back a stale copy of the rest.
use corten::UrlValue;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::database::Database;

const CONFIG_KEY: &str = "default";
const MINUTE_MS: u64 = 60_000;

/// Where a batch of price or quantity changes comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    PendingInventory,
    Seller,
    Csv,
    Continuous,
}

impl Source {
    pub const ALL: [Source; 4] = [
        Source::PendingInventory,
        Source::Seller,
        Source::Csv,
        Source::Continuous,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Source::PendingInventory => "Inventory Manager batches",
            Source::Seller => "Seller inventory batches",
            Source::Csv => "CSV batches (price-only; quantity deltas remain manual)",
            Source::Continuous => "Continuous pricing candidates",
        }
    }
}

/// The settings on this screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub global_paused: bool,
    pub consecutive_failure_limit: u32,
    pub automatic_publishing_enabled: bool,
    /// The sources that publish by themselves, in [`Source::ALL`]'s order.
    pub automatic_sources: Vec<Source>,
    pub allow_warnings: bool,
    pub maximum_candidate_age_minutes: u32,
    pub minimum_absolute_price_change: f64,
    pub staged_micro_batch_maximum: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            global_paused: false,
            consecutive_failure_limit: 3,
            automatic_publishing_enabled: false,
            automatic_sources: Vec::new(),
            allow_warnings: false,
            maximum_candidate_age_minutes: 60,
            minimum_absolute_price_change: 0.01,
            staged_micro_batch_maximum: 250,
        }
    }
}

/// The ranges a setting must be in; the Node app reads one outside them as its default.
pub mod range {
    use std::ops::RangeInclusive;

    pub const FAILURE_LIMIT: RangeInclusive<u32> = 1..=100;
    pub const CANDIDATE_AGE_MINUTES: RangeInclusive<u32> = 1..=10_080;
    pub const PRICE_CHANGE: RangeInclusive<f64> = 0.0..=10_000.0;
    pub const MICRO_BATCH: RangeInclusive<u32> = 1..=750;
}

impl Settings {
    /// The settings in a stored document, each missing or out-of-range value its default, as
    /// `normalizeInventoryPublicationSettings` reads them.
    pub fn of(stored: &Value) -> Self {
        let d = Settings::default();
        let policy = &stored["policy"];
        // JSON has one number type: `250.0` is the whole number 250, as JavaScript reads it.
        let integer = |value: &Value| {
            value
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= u64::MAX as f64)
                .map(|n| n as u64)
        };
        let whole = |value: &Value, range: std::ops::RangeInclusive<u32>, fallback: u32| {
            integer(value)
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| range.contains(n))
                .unwrap_or(fallback)
        };
        let flag = |value: &Value, fallback: bool| value.as_bool().unwrap_or(fallback);
        let age_ms = integer(&policy["maximumCandidateAgeMs"])
            .filter(|ms| (MINUTE_MS..=7 * 24 * 60 * MINUTE_MS).contains(ms));
        Settings {
            global_paused: flag(&stored["globalPaused"], d.global_paused),
            consecutive_failure_limit: whole(
                &stored["consecutiveFailureLimit"],
                range::FAILURE_LIMIT,
                d.consecutive_failure_limit,
            ),
            automatic_publishing_enabled: flag(
                &policy["automaticPublishingEnabled"],
                d.automatic_publishing_enabled,
            ),
            automatic_sources: Source::ALL
                .into_iter()
                .filter(|s| policy["automaticSources"][s.as_ref()].as_bool() == Some(true))
                .collect(),
            allow_warnings: flag(&policy["allowWarnings"], d.allow_warnings),
            maximum_candidate_age_minutes: age_ms.map_or(d.maximum_candidate_age_minutes, |ms| {
                (ms as f64 / MINUTE_MS as f64).round() as u32
            }),
            minimum_absolute_price_change: policy["minimumAbsolutePriceChange"]
                .as_f64()
                .filter(|n| range::PRICE_CHANGE.contains(n))
                .unwrap_or(d.minimum_absolute_price_change),
            staged_micro_batch_maximum: whole(
                &policy["stagedMicroBatchMaximum"],
                range::MICRO_BATCH,
                d.staged_micro_batch_maximum,
            ),
        }
    }

    /// This screen's keys at the top of the document, and in its `policy`.
    fn documents(&self) -> (Value, Value) {
        let sources: serde_json::Map<String, Value> = Source::ALL
            .into_iter()
            .map(|s| {
                (
                    s.as_ref().to_owned(),
                    self.automatic_sources.contains(&s).into(),
                )
            })
            .collect();
        (
            json!({
                "globalPaused": self.global_paused,
                "consecutiveFailureLimit": self.consecutive_failure_limit,
            }),
            json!({
                "automaticPublishingEnabled": self.automatic_publishing_enabled,
                "automaticSources": sources,
                "allowWarnings": self.allow_warnings,
                "maximumCandidateAgeMs": u64::from(self.maximum_candidate_age_minutes) * MINUTE_MS,
                "minimumAbsolutePriceChange": self.minimum_absolute_price_change,
                "stagedMicroBatchMaximum": self.staged_micro_batch_maximum,
            }),
        )
    }
}

/// Whether the publisher can reach Seller Portal, as its worker last found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authentication {
    Unknown,
    Healthy,
    Invalid,
}

impl Authentication {
    fn stored(word: &str) -> Self {
        match word {
            "healthy" => Authentication::Healthy,
            "invalid" => Authentication::Invalid,
            _ => Authentication::Unknown,
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            Authentication::Unknown => "unknown",
            Authentication::Healthy => "healthy",
            Authentication::Invalid => "invalid",
        }
    }
}

/// What the publisher's worker last recorded. The circuit opens after too many failures in a row
/// or a refused sign-in, and stays open until someone resumes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Runtime {
    pub authentication: Authentication,
    pub circuit_open: bool,
    pub consecutive_failures: i32,
    pub pause_reason: Option<String>,
}

impl Runtime {
    /// Whether publication is stopped until someone resumes it.
    pub fn needs_resume(&self) -> bool {
        self.circuit_open || self.authentication == Authentication::Invalid
    }
}

/// The stored settings and runtime, the row made first if there is none. An empty document reads
/// as every default, here and in the Node app.
pub async fn load(db: &Database) -> sqlx::Result<(Settings, Runtime)> {
    sqlx::query(
        "INSERT INTO inventory_publication_settings (config_key, settings_json)
        VALUES ($1, '{}'::jsonb) ON CONFLICT (config_key) DO NOTHING",
    )
    .bind(CONFIG_KEY)
    .execute(&db.0)
    .await?;
    let (stored, authentication, circuit_open, consecutive_failures, pause_reason): (
        Value,
        String,
        bool,
        i32,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT settings_json, authentication_status, circuit_open, consecutive_failures, pause_reason
        FROM inventory_publication_settings WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .fetch_one(&db.0)
    .await?;
    let runtime = Runtime {
        authentication: Authentication::stored(&authentication),
        circuit_open,
        consecutive_failures,
        pause_reason,
    };
    Ok((Settings::of(&stored), runtime))
}

pub async fn save(db: &Database, settings: &Settings) -> sqlx::Result<()> {
    let (top, policy) = settings.documents();
    sqlx::query(
        "INSERT INTO inventory_publication_settings (config_key, settings_json, updated_at)
        VALUES ($1, $2 || jsonb_build_object('policy', $3::jsonb), NOW())
        ON CONFLICT (config_key) DO UPDATE SET
            settings_json = inventory_publication_settings.settings_json || $2
                || jsonb_build_object('policy',
                    COALESCE(inventory_publication_settings.settings_json -> 'policy', '{}'::jsonb) || $3),
            updated_at = NOW()",
    )
    .bind(CONFIG_KEY)
    .bind(top)
    .bind(policy)
    .execute(&db.0)
    .await?;
    Ok(())
}

/// Closes the circuit and forgets the failures; a refused sign-in becomes unknown until the next
/// publication tries it.
pub async fn resume(db: &Database) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE inventory_publication_settings
        SET authentication_status = CASE WHEN authentication_status = 'invalid' THEN 'unknown'
                ELSE authentication_status END,
            circuit_open = FALSE, consecutive_failures = 0, pause_reason = NULL,
            runtime_updated_at = NOW()
        WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .execute(&db.0)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_document_reads_as_the_node_app_reads_it() {
        let stored = json!({
            "globalPaused": true,
            "consecutiveFailureLimit": 500,
            "policy": {
                "automaticPublishingEnabled": true,
                "automaticSources": { "csv": false, "continuous": true, "pending_inventory": "yes" },
                "maximumCandidateAgeMs": 86_400_000,
                "minimumAbsolutePriceChange": 0.25,
                "stagedMicroBatchMaximum": 250.5
            }
        });
        let settings = Settings::of(&stored);
        assert!(settings.global_paused);
        assert_eq!(
            settings.consecutive_failure_limit, 3,
            "out of range is the default"
        );
        assert_eq!(settings.automatic_sources, [Source::Continuous]);
        assert_eq!(settings.maximum_candidate_age_minutes, 1440);
        assert_eq!(settings.minimum_absolute_price_change, 0.25);
        assert_eq!(
            settings.staged_micro_batch_maximum, 250,
            "not whole is the default"
        );
    }

    #[test]
    fn the_written_keys_are_the_node_apps() {
        let settings = Settings {
            automatic_sources: vec![Source::PendingInventory],
            ..Settings::default()
        };
        let (top, policy) = settings.documents();
        assert_eq!(
            top,
            json!({ "globalPaused": false, "consecutiveFailureLimit": 3 })
        );
        assert_eq!(policy["automaticSources"]["pending_inventory"], true);
        assert_eq!(policy["automaticSources"]["seller"], false);
        assert_eq!(policy["maximumCandidateAgeMs"], 3_600_000);
        assert!(
            policy["stagedMicroBatchMaximum"].is_u64(),
            "an integer, not 250.0"
        );
    }

    #[test]
    fn written_settings_read_back_the_same() {
        let settings = Settings {
            global_paused: true,
            automatic_publishing_enabled: true,
            automatic_sources: vec![Source::Seller, Source::Continuous],
            maximum_candidate_age_minutes: 90,
            ..Settings::default()
        };
        let (mut stored, policy) = settings.documents();
        stored["policy"] = policy;
        assert_eq!(Settings::of(&stored), settings);
    }
}
