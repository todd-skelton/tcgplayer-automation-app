//! Evidence maintenance for a seller: refreshing confirmed inventory in small groups and
//! updating recommendations from fresh saved evidence. It never publishes prices. The settings
//! and the cycles stay the Node app's (`/api/slab-maintenance`, whose worker calls eBay and Alt).
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

/// How often the status is read again while maintenance is enabled, as the React panel did.
pub const FOLLOWING: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub settings: Settings,
    pub items: Vec<Check>,
    pub providers: Vec<Provider>,
    /// `external` when the worker runs in its own process.
    pub worker_mode: String,
}

/// The seller's maintenance settings, with the last cycle's outcome.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub include_supply: bool,
    pub interval_minutes: u32,
    pub batch_size: u32,
    pub refresh_budget: u32,
    pub revision: i64,
    pub next_cycle_at: Option<String>,
    pub last_cycle_at: Option<String>,
    pub last_error: Option<String>,
    pub last_summary: Option<Summary>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Summary {
    pub checked: u32,
    pub queued: u32,
    pub recalculated: u32,
    pub held: u32,
}

/// One listing a cycle checked, and what it did.
#[derive(Clone, Debug, Deserialize)]
pub struct Check {
    pub id: String,
    pub title: Option<String>,
    pub outcome: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Provider {
    pub provider: String,
    pub status: String,
}

/// The settings as the Node app saves them, at the revision the form was drawn from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved<'a> {
    pub seller: &'a str,
    pub enabled: bool,
    pub include_supply: bool,
    pub interval_minutes: i64,
    pub batch_size: i64,
    pub refresh_budget: i64,
    pub revision: i64,
}

/// The seller's maintenance as it stands.
pub async fn read(legacy: &Legacy, seller: &str) -> Result<View, String> {
    #[derive(Serialize)]
    struct Query<'a> {
        seller: &'a str,
    }
    legacy
        .read_with("/api/slab-maintenance", &Query { seller })
        .await
}
