//! The checks the Node app's inventory economics put entered evidence through before recording it
//! (`domain/money`, `domain/purchaseCostDetails` and the repository's own), in its words: amounts
//! in dollars, references and dates as JavaScript reads them. Intake's purchase cost uses them.
use serde_json::Value;

use crate::js_text::js_trim;

/// JavaScript's `length`: UTF-16 units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The largest whole number JavaScript counts exactly.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `dollarsToCents`: a nonnegative amount with at most two decimals, in cents.
pub fn dollars_to_cents(text: &str, label: &str) -> Result<i64, String> {
    let text = js_trim(text);
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|f| !digits(f) || f.len() > 2) {
        return Err(format!(
            "{label} must be a nonnegative amount with at most two decimal places."
        ));
    }
    let fraction = format!("{:0<2}", fraction.unwrap_or(""));
    whole
        .parse::<i64>()
        .ok()
        .and_then(|w| w.checked_mul(100)?.checked_add(fraction.parse().ok()?))
        .filter(|cents| *cents <= MAX_SAFE_INTEGER)
        .ok_or_else(|| format!("{label} is outside the supported range."))
}

/// `requiredText`: trimmed, and at most 200 characters.
pub fn required_text(text: &str, label: &str) -> Result<String, String> {
    let text = js_trim(text);
    if text.is_empty() || js_length(text) > 200 {
        return Err(format!(
            "{label} is required and limited to 200 characters."
        ));
    }
    Ok(text.to_owned())
}

/// `calendarDate`: none when blank, else a real `YYYY-MM-DD` date (as `Date.UTC` reads it,
/// which takes years below 100 for the 1900s, so those are refused).
pub fn calendar_date(text: Option<&str>) -> Result<Option<String>, String> {
    let Some(text) = text.map(js_trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if js_length(text) > 200 {
        return Err("Purchase date is limited to 200 characters.".to_owned());
    }
    let refused = || "Purchase date must be a calendar date in YYYY-MM-DD format.".to_owned();
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit());
    if !shaped {
        return Err(refused());
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    let year = i32::try_from(number(0..4)).unwrap_or(0);
    if year < 100 || chrono::NaiveDate::from_ymd_opt(year, number(5..7), number(8..10)).is_none() {
        return Err(refused());
    }
    Ok(Some(text.to_owned()))
}

/// `dollarsToCents` of a JSON value: only text is an amount.
pub fn js_dollars(value: Option<&Value>, label: &str) -> Result<i64, String> {
    match value {
        Some(Value::String(text)) => dollars_to_cents(text, label),
        _ => Err(format!(
            "{label} must be a nonnegative amount with at most two decimal places."
        )),
    }
}
