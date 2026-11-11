//! Seller Portal's staged pricing import (`staged-pricing-import.server.ts`): an upload opened,
//! filled in chunks of quantity deltas and prices, finalized, then moved live or rolled back.
//! Each is a form post never repeated, as the posts can carry quantity deltas: a failure whose
//! outcome is unknown is reconciled, not retried.
//!
//! The posts go through a [`Poster`], so the worker is tested against a stand-in; [`Live`]
//! posts to `store.tcgplayer.com` with the saved auth cookie.
use std::{future::Future, sync::LazyLock, time::Duration};

use regex::Regex;
use serde_json::Value;

use crate::{features::http_configuration::config::Domain, tcgplayer::TcgPlayer};

pub const INITIALIZE: &str = "/admin/pricing/initializeexportcsv";
pub const UPLOAD: &str = "/admin/pricing/uploadexportcsv";
pub const FINALIZE: &str = "/admin/pricing/finalizeexportcsv";
pub const ROLLBACK: &str = "/admin/pricing/rollbackexportcsv";
pub const MOVE_TO_LIVE: &str = "/admin/pricing/movetolive";

/// The most rows one upload post carries.
pub const CHUNK_SIZE: usize = 750;

const PRICING_TYPE: &str = "Pricing";

/// What Seller Portal answered a post.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    /// `json`, `html`, `text` or `other`, from the answer's content type; none when it had none.
    pub content_type: Option<String>,
    pub redirected: Option<bool>,
    /// The body: its JSON, or its text when it is not JSON.
    pub data: Value,
}

/// A post Seller Portal did not answer with success.
#[derive(Clone, Debug, PartialEq)]
pub struct Unsuccessful {
    pub message: String,
    /// The transport's code (`ECONNRESET`, `ECONNABORTED`, ...), when it failed before answering.
    pub code: Option<String>,
    /// What it answered instead of success, if anything.
    pub answer: Option<Answer>,
}

/// Posts a form to Seller Portal.
pub trait Poster: Sync {
    fn post(
        &self,
        path: &str,
        form: &str,
    ) -> impl Future<Output = Result<Answer, Unsuccessful>> + Send;
}

/// Why a step failed. The message is the one the Node app saves.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub message: String,
    /// The status Seller Portal refused the post with.
    pub status: Option<u16>,
    /// What went wrong opening the upload (`StagedPricingInitializationErrorCode`).
    pub initialization: Option<&'static str>,
}

impl Failure {
    pub fn new(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
            status: None,
            initialization: None,
        }
    }

    fn opening(code: &'static str, message: String) -> Self {
        Failure {
            message,
            status: None,
            initialization: Some(code),
        }
    }
}

impl From<Unsuccessful> for Failure {
    fn from(unsuccessful: Unsuccessful) -> Self {
        Failure {
            message: unsuccessful.message,
            status: unsuccessful.answer.map(|answer| answer.status),
            initialization: None,
        }
    }
}

/// One row of an upload.
#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    /// TCGplayer's ProductConditionId, the inventory SKU.
    pub sku: i64,
    /// Added to the live quantity when the upload goes live.
    pub add_to_quantity: i64,
    pub price: f64,
}

fn form(pairs: &[(&str, String)]) -> String {
    let mut form = form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        form.append_pair(name, value);
    }
    form.finish()
}

fn positive(value: i64, name: &str) -> Result<(), Failure> {
    if value > 0 {
        Ok(())
    } else {
        Err(Failure::new(format!("{name} must be a positive integer.")))
    }
}

/// The form that opens an upload.
pub fn initialize_form(file_name: &str) -> Result<String, Failure> {
    if file_name.trim().is_empty() {
        return Err(Failure::new("fileName must not be empty."));
    }
    Ok(form(&[
        ("filename", file_name.into()),
        ("type", PRICING_TYPE.into()),
    ]))
}

/// The form that adds `updates` to the upload.
pub fn upload_form(file_name: &str, upload_id: i64, updates: &[Update]) -> Result<String, Failure> {
    if file_name.trim().is_empty() {
        return Err(Failure::new("fileName must not be empty."));
    }
    positive(upload_id, "uploadId")?;
    if updates.is_empty() {
        return Err(Failure::new(
            "updates must contain at least one pricing update.",
        ));
    }
    if updates.len() > CHUNK_SIZE {
        return Err(Failure::new(format!(
            "updates must contain no more than {CHUNK_SIZE} pricing updates."
        )));
    }
    let mut pairs = Vec::with_capacity(updates.len() * 4 + 3);
    for (index, update) in updates.iter().enumerate() {
        let prefix = format!("updates[{index}]");
        positive(update.sku, &format!("{prefix}.sku"))?;
        if !(0.01..=200_000.0).contains(&update.price) {
            return Err(Failure::new(format!(
                "{prefix}.price must be a finite number between 0.01 and 200000."
            )));
        }
        let row = format!("data[{index}]");
        pairs.push((format!("{row}[Id]"), index.to_string()));
        pairs.push((format!("{row}[ProductConditionId]"), update.sku.to_string()));
        pairs.push((
            format!("{row}[AddToQuantity]"),
            update.add_to_quantity.to_string(),
        ));
        // Prices are whole cents, so no half-cent tie rounds differently from toFixed.
        pairs.push((format!("{row}[MyPrice]"), format!("{:.2}", update.price)));
    }
    let mut pairs: Vec<(&str, String)> =
        pairs.iter().map(|(n, v)| (n.as_str(), v.clone())).collect();
    pairs.push(("stagedPricingUploadId", upload_id.to_string()));
    pairs.push(("fileName", file_name.into()));
    pairs.push(("type", PRICING_TYPE.into()));
    Ok(form(&pairs))
}

/// The form that closes the upload with the rows Seller Portal accepted.
pub fn finalize_form(upload_id: i64, successful_product_count: i64) -> Result<String, Failure> {
    positive(upload_id, "uploadId")?;
    if successful_product_count < 0 {
        return Err(Failure::new(
            "successfulProductCount must be a non-negative integer.",
        ));
    }
    Ok(form(&[
        ("stagedPricingUploadId", upload_id.to_string()),
        ("productCount", successful_product_count.to_string()),
        ("type", PRICING_TYPE.into()),
    ]))
}

/// The form that discards the upload.
pub fn rollback_form(upload_id: i64) -> Result<String, Failure> {
    positive(upload_id, "uploadId")?;
    Ok(form(&[
        ("stagedPricingUploadId", upload_id.to_string()),
        ("type", PRICING_TYPE.into()),
    ]))
}

/// The form that moves the upload live.
pub fn move_to_live_form(upload_id: i64) -> Result<String, Failure> {
    positive(upload_id, "uploadId")?;
    Ok(form(&[
        ("scope", "3".into()),
        ("connectionId", String::new()),
        ("stagedPricingUploadId", upload_id.to_string()),
        ("type", PRICING_TYPE.into()),
    ]))
}

/// Whether JavaScript reads the value as true.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

static HTML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<html(?-u:\b)|<!doctype\s+html").expect("valid"));
static LOGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)<form(?-u:\b)[^>]*(login|sign.?in)|(?-u:\b)(login|sign in|authentication)(?-u:\b)",
    )
    .expect("valid")
});
static CHALLENGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)captcha|cf-chl-|challenge-platform|verify you are human|access denied")
        .expect("valid")
});

fn value_kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Array(_)) => "array",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Object(_)) => "object",
    }
}

fn html(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| HTML.is_match(text))
}

fn response_kind(value: Option<&Value>) -> &'static str {
    if html(value).is_some() {
        "html"
    } else {
        value_kind(value)
    }
}

fn known_field_shape(value: Option<&Value>) -> String {
    let Some(Value::Object(record)) = value else {
        return "none".into();
    };
    let fields: Vec<String> = [
        "StagedPricingUploadId",
        "Success",
        "success",
        "Error",
        "Errors",
        "error",
        "errors",
        "Message",
        "Messages",
    ]
    .iter()
    .filter_map(|name| {
        record
            .get(*name)
            .map(|field| format!("{name}:{}", value_kind(Some(field))))
    })
    .collect();
    if fields.is_empty() {
        "none".into()
    } else {
        fields.join(",")
    }
}

/// What can be said safely of an answer: its status, kind of content and whether it redirected.
#[derive(Clone, Debug)]
struct Metadata<'a> {
    status: u16,
    content_type: Option<&'a str>,
    redirected: Option<bool>,
}

fn metadata(answer: &Answer) -> Metadata<'_> {
    Metadata {
        status: answer.status,
        content_type: answer.content_type.as_deref(),
        redirected: answer.redirected,
    }
}

fn metadata_shape(metadata: Option<&Metadata>) -> String {
    let Some(m) = metadata else {
        return "status=unknown; contentType=unknown; redirected=unknown".into();
    };
    format!(
        "status={}; contentType={}; redirected={}",
        m.status,
        m.content_type.unwrap_or("unknown"),
        m.redirected.map_or("unknown".into(), |r| r.to_string())
    )
}

fn diagnostics(response: Option<&Value>, metadata: Option<&Metadata>) -> String {
    format!(
        "{}; response={}; fields={}",
        metadata_shape(metadata),
        response_kind(response),
        known_field_shape(response)
    )
}

fn explicit_error(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => false,
    }
}

fn explicit_rejection(response: Option<&Value>) -> bool {
    let Some(Value::Object(record)) = response else {
        return false;
    };
    record.get("Success") == Some(&Value::Bool(false))
        || record.get("success") == Some(&Value::Bool(false))
        || ["Error", "Errors", "error", "errors"]
            .iter()
            .any(|name| record.get(*name).is_some_and(explicit_error))
}

fn login(response: Option<&Value>, metadata: Option<&Metadata>) -> bool {
    matches!(metadata.map(|m| m.status), Some(401 | 403))
        || html(response).is_some_and(|text| LOGIN.is_match(text))
}

fn challenge(response: Option<&Value>) -> bool {
    html(response).is_some_and(|text| CHALLENGE.is_match(text))
}

const SAFE_TRANSPORT_CODES: [&str; 7] = [
    "ECONNABORTED",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ERR_CANCELED",
    "ERR_NETWORK",
];

pub const AUTHENTICATION_REQUIRED: &str = "staged_initialization_authentication_required";

/// Opens an upload named `file_name` (`initializeStagedPricingImport`), answering its id. A
/// failure says whether Seller Portal challenged the post, wanted a sign-in, refused it, failed,
/// or was not reached, with what can be said safely of its answer.
pub async fn initialize(portal: &impl Poster, file_name: &str) -> Result<i64, Failure> {
    let form = initialize_form(file_name)?;
    let answer = match portal.post(INITIALIZE, &form).await {
        Ok(answer) => answer,
        Err(failed) => {
            let code = failed
                .code
                .as_deref()
                .filter(|code| SAFE_TRANSPORT_CODES.contains(code))
                .unwrap_or("other");
            let response = failed.answer.as_ref().map(|answer| &answer.data);
            let metadata = failed.answer.as_ref().map(metadata);
            let shown = diagnostics(response, metadata.as_ref());
            let status = metadata.as_ref().map(|m| m.status);
            let (kind, message) = if challenge(response) {
                (
                    "staged_initialization_challenge",
                    "Seller Portal challenged the staged pricing initialization request",
                )
            } else if login(response, metadata.as_ref()) {
                (
                    AUTHENTICATION_REQUIRED,
                    "Seller Portal required authentication for staged pricing initialization",
                )
            } else if explicit_rejection(response)
                || status.is_some_and(|s| (400..500).contains(&s))
            {
                (
                    "staged_initialization_rejected",
                    "Seller Portal rejected staged pricing initialization",
                )
            } else if status.is_some() {
                (
                    "staged_initialization_http_failed",
                    "Seller Portal returned an HTTP failure during staged pricing initialization",
                )
            } else {
                (
                    "staged_initialization_transport_failed",
                    "Seller Portal staged pricing initialization failed before a response was confirmed",
                )
            };
            return Err(Failure::opening(
                kind,
                format!("{message} ({shown}; transport={code})."),
            ));
        }
    };
    let response = Some(&answer.data);
    let metadata = metadata(&answer);
    let shown = diagnostics(response, Some(&metadata));
    if challenge(response) {
        return Err(Failure::opening(
            "staged_initialization_challenge",
            format!(
                "Seller Portal challenged the staged pricing initialization request ({shown})."
            ),
        ));
    }
    if login(response, Some(&metadata)) {
        return Err(Failure::opening(
            AUTHENTICATION_REQUIRED,
            format!(
                "Seller Portal required authentication for staged pricing initialization ({shown})."
            ),
        ));
    }
    if explicit_rejection(response) {
        return Err(Failure::opening(
            "staged_initialization_rejected",
            format!("Seller Portal rejected staged pricing initialization ({shown})."),
        ));
    }
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    match answer
        .data
        .get("StagedPricingUploadId")
        .and_then(Value::as_f64)
    {
        Some(id) if id > 0.0 && id.fract() == 0.0 && id <= MAX_SAFE => Ok(id as i64),
        _ => Err(Failure::opening(
            "staged_initialization_response_invalid",
            format!(
                "Seller Portal returned an invalid staged pricing initialization response ({shown})."
            ),
        )),
    }
}

/// A message Seller Portal answered, as text.
pub fn message_text(message: &Value) -> String {
    match message {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Seller Portal's messages as the Node app quotes them (`formatSellerPortalMessages`).
pub fn quoted_messages(messages: Option<&[Value]>) -> String {
    let joined: Vec<String> = messages
        .unwrap_or_default()
        .iter()
        .map(message_text)
        .filter(|message| !message.is_empty())
        .collect();
    let joined = joined.join("; ");
    if joined.is_empty() {
        return String::new();
    }
    let shown: String = joined.chars().take(1_000).collect();
    format!("Seller Portal messages: {shown}")
}

/// Why Seller Portal refused an upload of `rows` rows: the rows it still counted as accepted, if
/// any, and its messages, so the failure keeps its reason.
fn refused_upload(upload_id: i64, rows: usize, data: &Value) -> Failure {
    let mut message = format!("TCGplayer did not accept staged pricing upload {upload_id}.");
    let accepted = data
        .get("SuccessfulProductCount")
        .and_then(Value::as_f64)
        .filter(|accepted| *accepted > 0.0);
    if let Some(accepted) = accepted {
        message = format!("{message} TCGplayer accepted {accepted} of {rows} staged pricing rows.");
    }
    let quoted = quoted_messages(
        data.get("Messages")
            .and_then(Value::as_array)
            .map(Vec::as_slice),
    );
    if !quoted.is_empty() {
        message = format!("{message} {quoted}");
    }
    Failure::new(message)
}

/// What an upload post accepted.
#[derive(Clone, Debug, PartialEq)]
pub struct Uploaded {
    /// `SuccessfulProductCount` as answered.
    pub successful: Option<Value>,
    pub messages: Option<Vec<Value>>,
}

/// Adds `updates` to the upload (`uploadStagedPricingChunk`).
pub async fn upload(
    portal: &impl Poster,
    file_name: &str,
    upload_id: i64,
    updates: &[Update],
) -> Result<Uploaded, Failure> {
    let answer = portal
        .post(UPLOAD, &upload_form(file_name, upload_id, updates)?)
        .await?;
    if !truthy(answer.data.get("Success")) {
        return Err(refused_upload(upload_id, updates.len(), &answer.data));
    }
    Ok(Uploaded {
        successful: answer.data.get("SuccessfulProductCount").cloned(),
        messages: answer
            .data
            .get("Messages")
            .and_then(Value::as_array)
            .cloned(),
    })
}

/// Closes the upload with the rows accepted (`finalizeStagedPricingImport`).
pub async fn finalize(
    portal: &impl Poster,
    upload_id: i64,
    successful_product_count: i64,
) -> Result<(), Failure> {
    let answer = portal
        .post(
            FINALIZE,
            &finalize_form(upload_id, successful_product_count)?,
        )
        .await?;
    if !truthy(answer.data.get("success")) {
        return Err(Failure::new(format!(
            "TCGplayer did not finalize staged pricing upload {upload_id}."
        )));
    }
    Ok(())
}

/// Discards the upload (`rollbackStagedPricingImport`).
pub async fn rollback(portal: &impl Poster, upload_id: i64) -> Result<(), Failure> {
    portal.post(ROLLBACK, &rollback_form(upload_id)?).await?;
    Ok(())
}

/// Moves the upload live (`moveStagedPricingImportToLive`), answering each SKU's outcome under
/// `Success`, `Update`, `Warning` or `Error`.
pub async fn move_to_live(portal: &impl Poster, upload_id: i64) -> Result<Value, Failure> {
    let answer = portal
        .post(MOVE_TO_LIVE, &move_to_live_form(upload_id)?)
        .await?;
    Ok(answer.data)
}

/// The kind of content a content type names, as the Node client classifies it.
fn content_kind(content_type: &str) -> &'static str {
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media == "application/json" || media.ends_with("+json") {
        "json"
    } else if media == "text/html" {
        "html"
    } else if media.starts_with("text/") {
        "text"
    } else {
        "other"
    }
}

/// How long one post may take. The Node client sets none; a post that never answers would hold
/// the publication's lease forever, so this one is given up and the publication reconciled.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Seller Portal itself, with the auth cookie saved in the HTTP settings.
pub struct Live(pub TcgPlayer);

impl Poster for Live {
    async fn post(&self, path: &str, form: &str) -> Result<Answer, Unsuccessful> {
        let answered = self
            .0
            .post_form(Domain::SellerPortal, path, form, TIMEOUT)
            .await
            .map_err(|unanswered| Unsuccessful {
                code: Some(
                    if unanswered.timed_out {
                        "ECONNABORTED"
                    } else {
                        "ERR_NETWORK"
                    }
                    .into(),
                ),
                message: unanswered.message,
                answer: None,
            })?;
        let data = serde_json::from_slice(&answered.body).unwrap_or_else(|_| {
            Value::String(String::from_utf8_lossy(&answered.body).into_owned())
        });
        let answer = Answer {
            status: answered.status,
            content_type: answered
                .content_type
                .as_deref()
                .map(|t| content_kind(t).to_owned()),
            redirected: Some(answered.redirected),
            data,
        };
        if (200..300).contains(&answer.status) {
            Ok(answer)
        } else {
            Err(Unsuccessful {
                message: format!("Request failed with status code {}", answer.status),
                code: None,
                answer: Some(answer),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_are_classified_as_the_node_client_classifies_them() {
        assert_eq!(content_kind("application/json; charset=utf-8"), "json");
        assert_eq!(content_kind("application/problem+json"), "json");
        assert_eq!(content_kind("Text/HTML"), "html");
        assert_eq!(content_kind("text/plain"), "text");
        assert_eq!(content_kind("image/png"), "other");
    }

    /// A refused upload keeps what Seller Portal said: its messages and the rows it still
    /// accepted; with neither, the message is the one Node saved.
    #[test]
    fn a_refused_upload_keeps_seller_portals_reason() {
        let refused = |data: Value| refused_upload(19149437, 32, &data).message;
        assert_eq!(
            refused(serde_json::json!({
                "Success": false,
                "SuccessfulProductCount": 31,
                "Messages": ["Row 12: price is below the minimum", { "Row": 20 }, ""],
            })),
            "TCGplayer did not accept staged pricing upload 19149437. TCGplayer accepted 31 of 32 \
             staged pricing rows. Seller Portal messages: Row 12: price is below the minimum; \
             {\"Row\":20}"
        );
        assert_eq!(
            refused(serde_json::json!({ "Success": false, "Messages": ["Invalid upload."] })),
            "TCGplayer did not accept staged pricing upload 19149437. Seller Portal messages: \
             Invalid upload."
        );
        assert_eq!(
            refused(serde_json::json!({
                "Success": false,
                "SuccessfulProductCount": 0,
                "Messages": [],
            })),
            "TCGplayer did not accept staged pricing upload 19149437."
        );
        assert_eq!(
            refused(Value::String("<html>Sign in</html>".into())),
            "TCGplayer did not accept staged pricing upload 19149437."
        );
    }

    #[test]
    fn javascript_truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&Value::Null)));
        assert!(!truthy(Some(&serde_json::json!(0))));
        assert!(!truthy(Some(&serde_json::json!(""))));
        assert!(truthy(Some(&serde_json::json!("false"))));
        assert!(truthy(Some(&serde_json::json!([]))));
    }
}
