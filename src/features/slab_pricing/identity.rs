//! A slab's certificate and what it identifies (`slab_identities`): the card and grade a
//! provider proposed, and the one the operator confirmed. Looking one up with Alt is `lookup`.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

use super::inventory::Expected;
use crate::{
    database::Database,
    features::{
        slab_connections::{ConnectionStatus as Status, Gate},
        slab_evidence::alt::Alt,
    },
};

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

/// A saved identity as JSON, to read as a [`Record`].
const RECORD: &str = "jsonb_build_object('id', id, 'grader', grader,
  'certificateNumber', certificate_number, 'candidate', candidate, 'identity', identity,
  'status', status, 'reviewReasons', review_reasons, 'revision', revision)::text";

/// The saved identity of a certificate, if it was looked up.
pub async fn find(
    db: &Database,
    grader: &str,
    certificate: &str,
) -> corten::Result<Option<Record>> {
    saved(&db.0, grader, certificate)
        .await
        .map_err(corten::Error::new)
}

/// [`find`] on a connection or in a transaction.
async fn saved<'c>(
    on: impl sqlx::PgExecutor<'c>,
    grader: &str,
    certificate: &str,
) -> sqlx::Result<Option<Record>> {
    let row: Option<String> = sqlx::query_scalar(&format!(
        "SELECT {RECORD} FROM slab_identities WHERE grader = $1 AND certificate_number = $2"
    ))
    .bind(grader)
    .bind(certificate)
    .fetch_optional(on)
    .await?;
    record(row)
}

fn record(row: Option<String>) -> sqlx::Result<Option<Record>> {
    row.map(|json| serde_json::from_str(&json).map_err(|e| sqlx::Error::Decode(e.into())))
        .transpose()
}

/// Why a certificate could not be looked up.
#[derive(Debug, PartialEq)]
pub enum Unresolved {
    /// Refused, in `SlabIdentityError`'s words.
    Refused(String),
    /// Alt did not answer, or the connection cannot be used now.
    Provider(Status),
    /// The database failed.
    Unavailable,
}

impl Unresolved {
    /// As `/api/slab-identities` words it.
    pub fn message(&self) -> String {
        match self {
            Unresolved::Refused(why) => why.clone(),
            Unresolved::Provider(status) => status.message().to_owned(),
            Unresolved::Unavailable => UNABLE.to_owned(),
        }
    }
}

fn unavailable(error: sqlx::Error) -> Unresolved {
    eprintln!("slab identity lookup: {error}");
    Unresolved::Unavailable
}

/// `slabIdentityService.lookup`: the certificate's saved identity, else (or, with `refresh`,
/// while unconfirmed) Alt's proposal for it saved for review, with why it needs one. The
/// connection is held while Alt answers; `cancel` resolving stops Alt's request.
///
/// Node also answers where the identity disagrees with what was expected of it; the screen reads
/// that from the listing (`inventory`), so it is not returned here.
pub async fn lookup<G: Gate>(
    conn: &mut PgConnection,
    alt: &Alt<'_, G>,
    (grader, number): (&str, &str),
    refresh: bool,
    cancel: impl Future<Output = ()> + Send,
) -> Result<Record, Unresolved> {
    let (grader, number) = certificate(grader, number).map_err(Unresolved::Refused)?;
    let found = saved(&mut *conn, &grader, &number)
        .await
        .map_err(unavailable)?;
    match found {
        Some(record) if !refresh || record.confirmed() => Ok(record),
        found => {
            let candidate = alt
                .certificate(&number, cancel)
                .await
                .map_err(Unresolved::Provider)?;
            let reasons = review_reasons(&grader, &number, candidate.as_ref());
            let revision = found.map(|r| r.revision);
            save_candidate(conn, (&grader, &number), candidate, &reasons, revision).await
        }
    }
}

/// Why Alt's proposal needs the operator: always confirmation, and before it where it differs
/// from the certificate asked about or leaves the grade's label unknown.
fn review_reasons(grader: &str, number: &str, candidate: Option<&Value>) -> Vec<&'static str> {
    let Some(candidate) = candidate else {
        return vec!["certificate-not-found"];
    };
    let mut reasons = Vec::new();
    if candidate["certificateNumber"] != number {
        reasons.push("certificate-mismatch");
    }
    if candidate["grader"] != grader {
        reasons.push("grader-mismatch");
    }
    if candidate["identity"]["grading"]["label"].is_null() {
        reasons.push("grade-label-unresolved");
    }
    reasons.push("confirmation-required");
    reasons
}

/// `saveCandidate`: a new certificate's proposal saved, or an unconfirmed one's replaced at the
/// revision read; when another lookup saved or confirmed it first, that one.
async fn save_candidate(
    conn: &mut PgConnection,
    (grader, number): (&str, &str),
    candidate: Option<Value>,
    reasons: &[&str],
    revision: Option<i64>,
) -> Result<Record, Unresolved> {
    let candidate = candidate.unwrap_or(Value::Null);
    let reasons = json!(reasons);
    let row: Option<String> = match revision {
        None => sqlx::query_scalar(&format!(
            "INSERT INTO slab_identities (id, grader, certificate_number, candidate, review_reasons)
             VALUES (gen_random_uuid(), $1, $2, $3, $4)
             ON CONFLICT (grader, certificate_number) DO NOTHING RETURNING {RECORD}"
        ))
        .bind(grader)
        .bind(number)
        .bind(&candidate)
        .bind(&reasons)
        .fetch_optional(&mut *conn)
        .await,
        Some(revision) => sqlx::query_scalar(&format!(
            "UPDATE slab_identities SET candidate = $3, review_reasons = $4, revision = revision + 1,
               updated_at = clock_timestamp()
             WHERE grader = $1 AND certificate_number = $2 AND revision = $5 AND status <> 'confirmed'
             RETURNING {RECORD}"
        ))
        .bind(grader)
        .bind(number)
        .bind(&candidate)
        .bind(&reasons)
        .bind(revision)
        .fetch_optional(&mut *conn)
        .await,
    }
    .map_err(unavailable)?;
    let stored = match record(row).map_err(unavailable)? {
        Some(stored) => Some(stored),
        None => saved(&mut *conn, grader, number)
            .await
            .map_err(unavailable)?,
    };
    stored.ok_or(Unresolved::Unavailable)
}

/// The card fields, in the order the valuation group key lists them (`CARD_FIELDS`).
const CARD_FIELDS: [&str; 9] = [
    "name",
    "game",
    "language",
    "set",
    "cardNumber",
    "year",
    "edition",
    "finish",
    "stamp",
];

const SHORT_TEXT: &str = "Identity fields must be short text values.";

/// JavaScript's `String.prototype.trim`.
pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `textField`: a string of at most `max` UTF-16 units without control characters, trimmed,
/// or none when it is missing or blank. Anything else is refused.
pub(super) fn text_field(value: &Value, max: usize) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if s.encode_utf16().count() <= max && !s.chars().any(|c| c < ' ') => {
            Ok(Some(js_trim(s))
                .filter(|t| !t.is_empty())
                .map(str::to_owned))
        }
        _ => Err(SHORT_TEXT.to_owned()),
    }
}

/// `normalizeExpectedIdentity`: what a slab is expected to be, each field short text or none, the
/// grade a number from 1 to 10.
pub(super) fn expected(value: &Value) -> Result<Expected, String> {
    let grade_number = match &value["gradeNumber"] {
        Value::Null => None,
        Value::Number(n) if n.as_f64().is_some_and(|n| (1.0..=10.0).contains(&n)) => n.as_f64(),
        _ => return Err("Expected numeric grade must be between 1 and 10.".to_owned()),
    };
    let text = |name: &str| text_field(&value[name], 200);
    Ok(Expected {
        name: text("name")?,
        game: text("game")?,
        language: text("language")?,
        set: text("set")?,
        card_number: text("cardNumber")?,
        year: text("year")?,
        edition: text("edition")?,
        finish: text("finish")?,
        stamp: text("stamp")?,
        grade_number,
        grade_label: text("gradeLabel")?,
        qualifier: text("qualifier")?,
        autograph: text("autograph")?,
    })
}

/// A grade number as JavaScript keeps it: whole ones without a fraction.
fn grade_number(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `normalizeCertificate`: the grader upper-cased and the number, both trimmed and plain.
pub(super) fn certificate(grader: &str, number: &str) -> Result<(String, String), String> {
    normalized_certificate(&json!(grader), &json!(number))
}

/// [`certificate`] of values as a provider answers them, which may not be text.
pub(crate) fn normalized_certificate(
    grader: &Value,
    number: &Value,
) -> Result<(String, String), String> {
    let grader = text_field(grader, 40)?.map(|g| g.to_uppercase());
    let number = text_field(number, 80)?;
    match (grader, number) {
        (Some(grader), Some(number))
            if grader.bytes().all(|b| {
                b.is_ascii_uppercase() || b.is_ascii_digit() || b == b' ' || b == b'-'
            }) && number
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
        {
            Ok((grader, number))
        }
        _ => Err("Enter a grader and certificate number.".to_owned()),
    }
}

/// `parseSlabIdentity`: the card and grade as saved, each field trimmed text or null, the grade
/// a half-step from 1 to 10 or none, and the provider asset an Alt one.
pub(crate) fn parse_identity(input: &Value) -> Result<Value, String> {
    let truthy = |v: &Value| {
        !matches!(v, Value::Null | Value::Bool(false)) && *v != json!("") && *v != json!(0)
    };
    if !input.is_object() || !truthy(&input["card"]) || !truthy(&input["grading"]) {
        return Err("Provide card identity and grading details.".to_owned());
    }
    let mut card = serde_json::Map::new();
    for field in CARD_FIELDS {
        card.insert(
            field.to_owned(),
            json!(text_field(&input["card"][field], 200)?),
        );
    }
    let grading = &input["grading"];
    let grader = text_field(&grading["grader"], 40)?.map(|g| g.to_uppercase());
    let encoding = text_field(&grading["encoding"], 40)?;
    let number = &grading["number"];
    let number_ok = match number {
        Value::Null => true,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|n| (1.0..=10.0).contains(&n) && (n * 2.0).fract() == 0.0),
        _ => false,
    };
    if card["name"].is_null() || grader.is_none() || encoding.is_none() || !number_ok {
        return Err("Provide a card name, grader and original grade encoding. Numeric grades must be between 1 and 10.".to_owned());
    }
    let asset = &input["providerAsset"];
    let provider_asset = if truthy(asset) {
        let id = text_field(&asset["id"], 80)?;
        let id = id.filter(|id| {
            asset["provider"] == "alt" && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
        let Some(id) = id else {
            return Err("Provide a valid provider asset reference.".to_owned());
        };
        json!({ "provider": "alt", "id": id, "title": text_field(&asset["title"], 500)? })
    } else {
        Value::Null
    };
    Ok(json!({
        "card": card,
        "grading": {
            "grader": grader,
            "encoding": encoding,
            "number": number.as_f64().map_or(Value::Null, grade_number),
            "label": text_field(&grading["label"], 200)?,
            "qualifier": text_field(&grading["qualifier"], 200)?,
            "autograph": text_field(&grading["autograph"], 200)?,
        },
        "providerAsset": provider_asset,
    }))
}

/// `valuationGroupKey`: the SHA-256 of the identity's ordered fields (card lower-cased, the
/// provider asset, the grader, the grade or its encoding, and its label, qualifier and
/// autograph lower-cased), as JSON. Slabs of one key are valued together.
fn valuation_group_key(identity: &Value) -> String {
    let lowered = |v: &Value| {
        v.as_str()
            .map_or(Value::Null, |s| json!(js_trim(s).to_lowercase()))
    };
    let grading = &identity["grading"];
    let asset = &identity["providerAsset"];
    let mut fields: Vec<Value> = CARD_FIELDS
        .iter()
        .map(|f| lowered(&identity["card"][*f]))
        .collect();
    fields.push(asset["provider"].clone());
    fields.push(asset["id"].clone());
    fields.push(grading["grader"].clone());
    fields.push(match &grading["number"] {
        Value::Null => grading["encoding"].clone(),
        number => number.clone(),
    });
    for field in ["label", "qualifier", "autograph"] {
        fields.push(lowered(&grading[field]));
    }
    hex::encode(Sha256::digest(Value::Array(fields).to_string()))
}

/// The operator's decision on what a certificate identifies, at the revision they saw.
pub struct Confirmation<'a> {
    /// The certificate and the reason as sent, each refused unless it is short text.
    pub grader: &'a Value,
    pub certificate_number: &'a Value,
    pub revision: i64,
    /// The card and grade as the screen sends them (`SlabIdentity` JSON).
    pub identity: &'a Value,
    pub note: &'a Value,
}

/// Why a confirmation was refused when the identity changed since it was read.
pub const CHANGED: &str = "The identity changed. Reload it before confirming.";
/// What `/api/slab-identities` answered when the database failed.
pub const UNABLE: &str = "Unable to resolve the identity. Try again.";

/// `confirm`: the identity saved as confirmed by the operator, with why, in its valuation group,
/// while the record is still at the revision they saw: its id. Refused in Node's words.
pub async fn confirm(
    conn: &mut sqlx::PgConnection,
    c: &Confirmation<'_>,
) -> Result<String, String> {
    let (grader, number) = normalized_certificate(c.grader, c.certificate_number)?;
    let identity = parse_identity(c.identity)?;
    let note = text_field(c.note, 1000)?;
    let label = identity["grading"]["label"]
        .as_str()
        .is_some_and(|l| !l.is_empty());
    let (Some(note), true, true, true) = (
        note,
        (1..=9_007_199_254_740_991).contains(&c.revision),
        identity["grading"]["grader"] == grader.as_str(),
        label,
    ) else {
        return Err("Confirm the grader and exact grade label, and record the reason for this identity decision.".to_owned());
    };
    let saved: Option<String> = sqlx::query_scalar(
        "UPDATE slab_identities
         SET identity = $4, valuation_group_key = $5, status = 'confirmed', review_reasons = '[]',
           revision = revision + 1, decision_source = 'manual', decision_note = $6, updated_at = clock_timestamp()
         WHERE grader = $1 AND certificate_number = $2 AND revision = $3 RETURNING id::text",
    )
    .bind(&grader)
    .bind(&number)
    .bind(c.revision)
    .bind(&identity)
    .bind(valuation_group_key(&identity))
    .bind(&note)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| {
        eprintln!("slab identity confirm: {error}");
        UNABLE.to_owned()
    })?;
    saved.ok_or_else(|| CHANGED.to_owned())
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
