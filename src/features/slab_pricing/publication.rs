//! Reviewing a listing's price change: a preview saved with the listing and its evidence, then a
//! dry run of its publication against the imported inventory. Both stay the Node app's
//! (`/api/slab-publication-previews`, `/api/slab-publications`) and neither contacts eBay; seller
//! OAuth and live readback are not connected, so nothing publishes.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

/// A saved price-change preview, and why it would need replacing now.
#[derive(Clone, Debug, Deserialize)]
pub struct Preview {
    pub id: String,
    pub plan: Plan,
    pub conflicts: Vec<String>,
}

/// The price change as it was saved: the listing, the old and new item price, and what it rests on.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub inventory: PlanInventory,
    pub old_price: Amount,
    pub new_price: Amount,
    pub change_percent: f64,
    /// `calculated` or `reviewed`.
    pub selection: String,
    pub identity: PlanIdentity,
    pub created_at: String,
    pub expires_at: String,
    pub evidence: Vec<serde_json::Value>,
    pub r#override: Option<PlanOverride>,
    pub flags: Vec<String>,
    pub policy_version: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInventory {
    pub item_id: String,
    pub seller: String,
    pub revision: i64,
    pub snapshot: PlanSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanSnapshot {
    pub title: String,
    pub quantity: i64,
    pub format: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Amount {
    pub amount: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanIdentity {
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanOverride {
    pub note: String,
}

impl Plan {
    /// Its review time is over (Node's `preview-expired` conflict says the same when read).
    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .parse::<DateTime<Utc>>()
            .map_or(true, |at| at <= now)
    }

    /// `+12.5%` or `-3.0%`.
    pub fn change(&self) -> String {
        let sign = if self.change_percent > 0.0 { "+" } else { "" };
        format!("{sign}{:.1}%", self.change_percent)
    }
}

/// One publication of a preview: its mode (`dry-run` or `live`), where it stands and why.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub state: String,
    pub reason: Option<String>,
    pub mode: String,
    pub created_at: String,
}

impl Run {
    /// A dry run stopped before it finished, which the same intent picks up again.
    pub fn resumable(&self) -> bool {
        self.mode == "dry-run" && matches!(self.state.as_str(), "approved" | "checking")
    }
}

/// A step a publication recorded, latest first.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub state: String,
    pub reason: Option<String>,
    pub created_at: String,
}

/// The listing's latest preview, its last publications, and the steps of the one asked about.
#[derive(Clone, Debug, Default)]
pub struct Review {
    pub preview: Option<Preview>,
    pub runs: Vec<Run>,
    /// The publication whose steps are shown, when it is one of this preview's.
    pub steps: Option<(String, Vec<Step>)>,
}

/// The most publications listed, as the React panel showed.
const MOST_RUNS: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForListing<'a> {
    inventory_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForPreview<'a> {
    preview_id: &'a str,
}

#[derive(Serialize)]
struct ForRun<'a> {
    id: &'a str,
}

#[derive(Deserialize)]
struct Runs {
    publications: Vec<Run>,
}

#[derive(Deserialize)]
struct Steps {
    events: Vec<Step>,
}

/// The listing's price-change review, with the steps of `steps` when it is one of its runs.
pub async fn read(legacy: &Legacy, listing: &str, steps: Option<&str>) -> Result<Review, String> {
    let previews = "/api/slab-publication-previews";
    let publications = "/api/slab-publications";
    let preview: Option<Preview> = legacy
        .read_with(
            previews,
            &ForListing {
                inventory_id: listing,
            },
        )
        .await?;
    let Some(preview) = preview else {
        return Ok(Review::default());
    };
    let mut runs = legacy
        .read_with::<Runs, _>(
            publications,
            &ForPreview {
                preview_id: &preview.id,
            },
        )
        .await?
        .publications;
    runs.truncate(MOST_RUNS);
    let steps = match steps.filter(|id| runs.iter().any(|r| r.id == *id)) {
        Some(id) => {
            let read: Steps = legacy.read_with(publications, &ForRun { id }).await?;
            Some((id.to_owned(), read.events))
        }
        None => None,
    };
    Ok(Review {
        preview: Some(preview),
        runs,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(change: f64, expires: &str) -> Plan {
        serde_json::from_value(serde_json::json!({
            "inventory": { "itemId": "1", "seller": "s", "revision": 2,
                "snapshot": { "title": "t", "quantity": 1, "format": "fixed-price" } },
            "oldPrice": { "amount": 100.0 }, "newPrice": { "amount": 112.5 },
            "changePercent": change, "selection": "calculated", "identity": { "revision": 1 },
            "createdAt": "2026-10-30T00:00:00Z", "expiresAt": expires, "evidence": [{}],
            "override": null, "flags": [], "policyVersion": "slab-policy-v1",
            "version": "reviewed-price-v1"
        }))
        .unwrap()
    }

    #[test]
    fn a_plan_expires_at_its_time() {
        let now: DateTime<Utc> = "2026-10-30T00:10:00Z".parse().unwrap();
        assert!(!plan(1.0, "2026-10-30T00:15:00Z").expired(now));
        assert!(plan(1.0, "2026-10-30T00:10:00Z").expired(now));
        assert!(plan(1.0, "not a date").expired(now));
    }

    #[test]
    fn a_change_is_signed_as_the_react_panel_wrote_it() {
        assert_eq!(plan(12.5, "").change(), "+12.5%");
        assert_eq!(plan(-3.0, "").change(), "-3.0%");
        assert_eq!(plan(0.0, "").change(), "0.0%");
    }

    #[test]
    fn only_a_stopped_dry_run_resumes() {
        let run = |mode: &str, state: &str| Run {
            id: "r".into(),
            state: state.into(),
            reason: None,
            mode: mode.into(),
            created_at: String::new(),
        };
        assert!(run("dry-run", "checking").resumable());
        assert!(run("dry-run", "approved").resumable());
        assert!(!run("dry-run", "dry-run").resumable());
        assert!(!run("live", "checking").resumable());
    }
}
