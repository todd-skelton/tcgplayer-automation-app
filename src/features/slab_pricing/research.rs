//! Research for the certificate shown: the evidence saved for a grade (the owned one, or a PSA
//! grade explored beside it) over a window of sale dates, and whether a refresh is on its way.
//! Planning the evidence and refreshing it stay the Node app's (`/api/slab-workspace`,
//! `/api/slab-evidence`), whose worker calls eBay and Alt; this reads what they saved.
use chrono::{Days, NaiveDate, Utc};
use chrono_tz::America::Chicago;
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

/// The PSA grades a slab can be explored at beside its own: every half grade from 1 to 10 but
/// 9.5, which PSA does not give.
pub const PSA_GRADES: [&str; 18] = [
    "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5",
    "9", "10",
];

/// The sale dates evidence is read over, as `YYYY-MM-DD`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Window {
    pub from: String,
    pub to: String,
}

impl Window {
    /// The year up to today in Chicago, where the seller works, as the React screen chose it.
    pub fn last_year() -> Window {
        Window::year_to(Utc::now().with_timezone(&Chicago).date_naive())
    }

    fn year_to(today: NaiveDate) -> Window {
        let from = today.checked_sub_days(Days::new(365)).unwrap_or(today);
        Window {
            from: from.format("%Y-%m-%d").to_string(),
            to: today.format("%Y-%m-%d").to_string(),
        }
    }
}

/// What is saved for a slab's research at one grade and window.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub statuses: Vec<EvidenceStatus>,
    pub keys: Vec<String>,
    /// Why no cross-grade estimate is offered.
    pub grade_model: Option<GradeModel>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GradeModel {
    pub reason: String,
}

/// One piece of evidence (eBay sales, Alt sales, supply) and where its refresh stands.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceStatus {
    pub key: String,
    pub spec: Spec,
    /// `queued`, `running`, `idle`, `failed` or `cancelled`.
    pub state: String,
    pub run_id: String,
    pub fetched_at: Option<String>,
    pub error_code: Option<String>,
    /// Expired, never fetched, or failed.
    pub stale: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Spec {
    pub kind: String,
}

impl EvidenceStatus {
    /// A refresh is queued or running, so the panel reads it again.
    pub fn pending(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "running")
    }
}

impl Workspace {
    pub fn pending(&self) -> bool {
        self.statuses.iter().any(EvidenceStatus::pending)
    }
}

#[derive(Serialize)]
struct Asked<'a> {
    id: &'a str,
    grade: &'a str,
    from: &'a str,
    to: &'a str,
}

/// The slab's research at `grade` (`owned` or a PSA grade) over `window`.
pub async fn read(
    legacy: &Legacy,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Workspace, String> {
    let asked = Asked {
        id,
        grade,
        from: &window.from,
        to: &window.to,
    };
    legacy.read_with("/api/slab-workspace", &asked).await
}

#[derive(Deserialize)]
struct Statuses {
    statuses: Vec<EvidenceStatus>,
}

/// Where the refreshes of `keys` stand. Asking keeps the Node app's refresh worker running
/// while one is queued, as the React screen's poll did.
pub async fn statuses(legacy: &Legacy, keys: &[String]) -> Result<Vec<EvidenceStatus>, String> {
    #[derive(Serialize)]
    struct Keys {
        keys: String,
    }
    let keys = Keys {
        keys: keys.join(","),
    };
    legacy
        .read_with::<Statuses, _>("/api/slab-evidence", &keys)
        .await
        .map(|s| s.statuses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_window_is_the_year_to_today() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(
            Window::year_to(today),
            Window {
                from: "2025-10-30".into(),
                to: "2026-10-30".into()
            }
        );
    }

    #[test]
    fn a_queued_or_running_refresh_is_pending() {
        let status = |state: &str| -> EvidenceStatus {
            serde_json::from_value(serde_json::json!({
                "key": "k", "spec": { "kind": "ebay-sales" }, "state": state, "runId": "r",
                "latestRevision": null, "fetchedAt": null, "errorCode": null, "stale": true
            }))
            .unwrap()
        };
        assert!(status("queued").pending());
        assert!(status("running").pending());
        assert!(!status("failed").pending());
    }
}
