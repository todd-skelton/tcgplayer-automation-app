//! Checking that a saved connection still reads data: the smallest read each provider answers
//! with the signed-in user's access. Ported from `connections/checkProviderConnection.server.ts`.
use std::{future::Future, sync::LazyLock};

use chrono::Utc;
use regex::Regex;
use reqwest::Url;
use serde_json::Value;

use super::{
    provider::{Provider, Status},
    request::{Ask, Check, Gate, Transport},
};

const ALT_ME: &str = r#"{"operationName":"Me","variables":{},"query":"query Me { me { id } }"}"#;

/// Asks `provider` who is signed in (Alt) or for one sold listing (eBay); `Ok` when the answer
/// is the signed-in one this app reads.
pub async fn check<G: Gate>(
    transport: &Transport,
    gate: &G,
    provider: Provider,
    cancel: impl Future<Output = ()> + Send,
) -> Result<(), Status> {
    let (ask, read): (Ask, Check) = match provider {
        Provider::Alt => (Ask::post("/graphql/Me", ALT_ME.to_owned()), read_alt),
        Provider::EbayResearch => (Ask::get(one_sold_listing()), read_ebay),
    };
    transport
        .request(gate, provider, ask, read, cancel)
        .await
        .map(drop)
}

/// eBay Research's search for one sale in the last 90 days.
fn one_sold_listing() -> String {
    let end = Utc::now().timestamp_millis();
    let start = end - 90 * 86_400_000;
    let mut url = Url::parse("https://www.ebay.com/sh/research/api/search").expect("a URL");
    url.query_pairs_mut()
        .append_pair("marketplace", "EBAY-US")
        .append_pair("keywords", "Ponyta 60 1st PSA 9")
        .append_pair("dayRange", "90")
        .append_pair("startDate", &start.to_string())
        .append_pair("endDate", &end.to_string())
        .append_pair("categoryId", "0")
        .append_pair("offset", "0")
        .append_pair("limit", "1")
        .append_pair("tabName", "SOLD")
        .append_pair("tz", "America/Chicago")
        .append_pair("modules", "resultsHeader");
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

/// Alt answers `me` with the signed-in user's id; `me: null` or an `UNAUTHENTICATED` error is a
/// session that has expired.
pub fn read_alt(body: &str) -> Result<(), Status> {
    let answer: Value = serde_json::from_str(body).map_err(|_| Status::InvalidResponse)?;
    let errors = answer.get("errors").and_then(Value::as_array);
    let code = |error: &Value| {
        error.pointer("/extensions/code").and_then(Value::as_str) == Some("UNAUTHENTICATED")
    };
    let unauthenticated = errors.is_some_and(|errors| errors.iter().any(code));
    let signed_out = answer.pointer("/data/me").is_some_and(Value::is_null);
    if unauthenticated || signed_out {
        return Err(Status::ReconnectRequired);
    }
    let has_errors = errors.is_some_and(|errors| !errors.is_empty());
    let id = answer
        .pointer("/data/me/id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if has_errors || id.is_empty() {
        Err(Status::InvalidResponse)
    } else {
        Ok(())
    }
}

/// eBay Research answers JSON modules separated by blank lines; a signed-in search has a results
/// header with its active tab.
pub fn read_ebay(body: &str) -> Result<(), Status> {
    static BLANK_LINE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\r?\n\s*\r?\n").expect("a pattern"));
    let modules = BLANK_LINE
        .split(body.trim())
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Status::InvalidResponse)?;
    let active = |tab: &Value| tab.get("active").and_then(Value::as_bool) == Some(true);
    let results_header = |module: &Value| {
        module.get("_type").and_then(Value::as_str) == Some("ResultsHeaderModule")
            && module
                .get("tabs")
                .and_then(Value::as_array)
                .is_some_and(|tabs| tabs.iter().any(active))
    };
    if modules.iter().any(results_header) {
        Ok(())
    } else {
        Err(Status::InvalidResponse)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alt_reads_the_signed_in_user() {
        assert_eq!(read_alt(r#"{"data":{"me":{"id":"fixture"}}}"#), Ok(()));
        assert_eq!(
            read_alt(r#"{"data":{"me":null}}"#),
            Err(Status::ReconnectRequired)
        );
        let expired = r#"{"errors":[{"extensions":{"code":"UNAUTHENTICATED"}}]}"#;
        assert_eq!(read_alt(expired), Err(Status::ReconnectRequired));
        for body in ["null", "{}", r#"{"errors":[{"message":"schema changed"}]}"#] {
            assert_eq!(read_alt(body), Err(Status::InvalidResponse), "{body}");
        }
    }

    #[test]
    fn ebay_reads_the_results_header() {
        let error = r#"{"_type":"PageErrorModule"}"#;
        let header = r#"{"_type":"ResultsHeaderModule","tabs":[{"active":true}]}"#;
        assert_eq!(read_ebay(&[error, header].join("\n \n")), Ok(()));
        for body in ["null", "{}", r#"{"_type":"ResultsHeaderModule","tabs":{}}"#] {
            assert_eq!(read_ebay(body), Err(Status::InvalidResponse), "{body}");
        }
    }

    #[test]
    fn the_ebay_search_stays_on_its_path() {
        let path = one_sold_listing();
        let start = "/sh/research/api/search?marketplace=EBAY-US&keywords=Ponyta+60+1st+PSA+9&";
        assert!(path.starts_with(start), "{path}");
    }
}
