//! A slab's certificate and what it identifies (`slab_identities`): the card and grade a
//! provider proposed, and the one the operator confirmed. Looking one up or confirming it stays
//! the Node app's (`/api/slab-identities`); this reads what was saved.
use serde::{Deserialize, Serialize};

use crate::database::Database;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub name: Option<String>,
    pub game: Option<String>,
    pub language: Option<String>,
    pub set: Option<String>,
    pub card_number: Option<String>,
    pub year: Option<String>,
    pub edition: Option<String>,
    pub finish: Option<String>,
    pub stamp: Option<String>,
}

impl Card {
    /// Year, set, number, finish and language, as the identity card's line under its title.
    pub fn summary(&self) -> String {
        [
            &self.year,
            &self.set,
            &self.card_number,
            &self.finish,
            &self.language,
        ]
        .into_iter()
        .filter_map(|v| v.as_deref().filter(|v| !v.is_empty()))
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grading {
    pub grader: String,
    pub encoding: String,
    pub number: Option<f64>,
    pub label: Option<String>,
    pub qualifier: Option<String>,
    pub autograph: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlabIdentity {
    pub card: Card,
    pub grading: Grading,
    /// The provider's asset the card was matched to, kept as it came when the operator confirms.
    #[serde(default)]
    pub provider_asset: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Candidate {
    pub identity: SlabIdentity,
}

/// A certificate's saved identity: proposed (`needs-review`) or `confirmed`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub grader: String,
    pub certificate_number: String,
    #[serde(default)]
    pub candidate: Option<Candidate>,
    #[serde(default)]
    pub identity: Option<SlabIdentity>,
    pub status: String,
    #[serde(default)]
    pub review_reasons: Vec<String>,
    pub revision: i64,
}

impl Record {
    /// The identity to show: the confirmed one, else the provider's proposal.
    pub fn shown(&self) -> Option<&SlabIdentity> {
        self.identity
            .as_ref()
            .or(self.candidate.as_ref().map(|c| &c.identity))
    }

    pub fn confirmed(&self) -> bool {
        self.status == "confirmed"
    }
}

/// The saved identity of a certificate, if it was looked up.
pub async fn find(
    db: &Database,
    grader: &str,
    certificate: &str,
) -> corten::Result<Option<Record>> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'grader', grader, 'certificateNumber', certificate_number,
           'candidate', candidate, 'identity', identity, 'status', status,
           'reviewReasons', review_reasons, 'revision', revision)::text
         FROM slab_identities WHERE grader = $1 AND certificate_number = $2",
    )
    .bind(grader)
    .bind(certificate)
    .fetch_optional(&db.0)
    .await
    .map_err(corten::Error::new)?;
    row.map(|json| serde_json::from_str(&json).map_err(corten::Error::new))
        .transpose()
}

/// `grade-label-unresolved` as "grade label unresolved", as the React screen wrote codes.
pub fn words(code: &str) -> String {
    code.replace(['-', '_'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_shows_its_confirmed_identity_before_the_proposal() {
        let record: Record = serde_json::from_str(
            r#"{"id":"0b5a","grader":"PSA","certificateNumber":"123","status":"needs-review","reviewReasons":["confirmation-required"],"revision":1,
                "candidate":{"grader":"PSA","certificateNumber":"123","identity":{"card":{"name":"Charizard","year":"1999","set":"Base Set","cardNumber":"4","finish":null,"language":"English","game":null,"edition":null,"stamp":null},"grading":{"grader":"PSA","encoding":"9","number":9,"label":"MINT","qualifier":null,"autograph":null},"providerAsset":{"provider":"alt","id":"a-1","title":null}}},
                "identity":null}"#,
        )
        .unwrap();
        let shown = record.shown().unwrap();
        assert_eq!(shown.card.summary(), "1999 · Base Set · 4 · English");
        assert_eq!(shown.grading.number, Some(9.0));
        assert!(!record.confirmed());
        assert_eq!(words("grade-label_unresolved"), "grade label unresolved");
    }
}
