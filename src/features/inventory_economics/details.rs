//! The checks the Node app's inventory economics put entered evidence through before recording it
//! (`domain/money`, `domain/purchaseCostDetails` and the repository's own), in its words: amounts
//! in dollars, references, currencies and dates as JavaScript reads them. Intake's purchase cost
//! and the economics route's actions share them.
use serde_json::Value;

use super::ledger::fingerprint::js_float;
use crate::api::js_trim;

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

/// A whole number as Postgres's `integer`, or refused as Postgres refused it when Node sent it
/// in an `int[]` parameter.
///
/// Node checks the rest of a request (and whether its id was used) before the query that meets
/// this; here a number past `integer` is refused once the request is read.
pub fn postgres_integer(n: f64) -> Result<i32, String> {
    if n > f64::from(i32::MAX) || n < f64::from(i32::MIN) {
        Err(format!(
            "value \"{}\" is out of range for type integer",
            js_float(n)
        ))
    } else {
        Ok(n as i32)
    }
}

/// `[...new Set(numbers)].sort((a, b) => a - b)`.
pub fn distinct(numbers: &[f64]) -> Vec<f64> {
    let mut numbers = numbers.to_vec();
    numbers.sort_by(f64::total_cmp);
    numbers.dedup();
    numbers
}

/// `normalizeCurrency`: three uppercase letters, as sent (trimmed, not upper-cased).
pub fn currency(text: &str) -> Result<String, String> {
    let currency = js_trim(text);
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("Currency must be a three-letter uppercase code.".to_owned());
    }
    Ok(currency.to_owned())
}

/// Whether `Date.parse(\`${text}T00:00:00Z\`)` reads `YYYY-MM-DD` text: V8 takes any month
/// 01 to 12 and any day 01 to 31, rolling a day past the month's end into the next month.
pub fn date_parses(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit());
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    shaped && (1..=12).contains(&number(5..7)) && (1..=31).contains(&number(8..10))
}

/// `normalizeDate` of the funding and expense ledgers: the `YYYY-MM-DD` text as sent. A day V8
/// rolls over (`2026-02-30`) passes here and is refused by Postgres when it is saved.
pub fn ledger_date(text: &str, label: &str) -> Result<String, String> {
    if date_parses(text) {
        Ok(text.to_owned())
    } else {
        Err(format!(
            "{label} must be a calendar date in YYYY-MM-DD format."
        ))
    }
}

/// `instant` of `normalizePurchaseCostDetails`: when the market evidence was observed, an ISO
/// time with a UTC offset, as `toISOString` writes it; none when blank.
///
/// V8 also reads a few other shapes ending in an offset (`Jan 1 2026 10:00 +05:00`); those are
/// refused here.
pub fn instant(text: Option<&str>) -> Result<Option<String>, String> {
    let Some(text) = text.map(js_trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if js_length(text) > 200 {
        return Err("Market evidence instant is limited to 200 characters.".to_owned());
    }
    let offset_ended = text.ends_with(['Z', 'z'])
        || text.len() >= 6
            && text.is_char_boundary(text.len() - 6)
            && matches!(text.as_bytes()[text.len() - 6], b'+' | b'-')
            && text.as_bytes()[text.len() - 3] == b':'
            && [5, 4, 2, 1]
                .iter()
                .all(|&back| text.as_bytes()[text.len() - back].is_ascii_digit());
    match js_date_parse(text).filter(|_| offset_ended) {
        Some(millis) => Ok(Some(iso_string(millis))),
        None => {
            Err("Market evidence instant must be an ISO timestamp with a UTC offset.".to_owned())
        }
    }
}

/// The furthest time from 1970 a JavaScript `Date` holds, in milliseconds.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// V8's `Date.parse` of an ISO date and time with a zone: `YYYY-MM-DD` (or a signed six-digit
/// year), then optionally `T`, `t` or a space and `HH:mm`, `:ss` and a fraction of any length
/// (read to the millisecond), then `Z`, `z` or an offset `+HH:mm`/`+HHmm`. Fields are range
/// checked as V8 checks them: a day up to 31 in any month (rolling over), 24:00 for midnight.
pub fn js_date_parse(text: &str) -> Option<i64> {
    let mut rest = text;
    let digits = |rest: &mut &str, n: usize| -> Option<i64> {
        let head = rest
            .get(..n)
            .filter(|h| h.bytes().all(|b| b.is_ascii_digit()))?;
        *rest = &rest[n..];
        head.parse().ok()
    };
    let take = |rest: &mut &str, c: char| -> bool {
        match rest.strip_prefix(c) {
            Some(after) => {
                *rest = after;
                true
            }
            None => false,
        }
    };
    let negative = rest.starts_with('-');
    let year = match rest.strip_prefix(['+', '-']) {
        Some(after) => {
            rest = after;
            let year = digits(&mut rest, 6)?;
            if negative && year == 0 {
                return None;
            }
            if negative { -year } else { year }
        }
        None => digits(&mut rest, 4)?,
    };
    if !take(&mut rest, '-') {
        return None;
    }
    let month = digits(&mut rest, 2)?;
    if !take(&mut rest, '-') {
        return None;
    }
    let day = digits(&mut rest, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    if let Some(after) = rest.strip_prefix(['T', 't', ' ']) {
        rest = after;
        hour = digits(&mut rest, 2)?;
        if !take(&mut rest, ':') {
            return None;
        }
        minute = digits(&mut rest, 2)?;
        if take(&mut rest, ':') {
            second = digits(&mut rest, 2)?;
            if take(&mut rest, '.') {
                let fraction: &str = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
                if fraction.is_empty() {
                    return None;
                }
                rest = &rest[fraction.len()..];
                millis = format!("{fraction:0<3}")[..3].parse().ok()?;
            }
        }
        let midnight = hour == 24 && minute == 0 && second == 0 && millis == 0;
        if !(hour < 24 || midnight) || minute > 59 || second > 59 {
            return None;
        }
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ => {
            let negative = rest.starts_with('-');
            rest = rest.strip_prefix(['+', '-'])?;
            let hours = digits(&mut rest, 2)?;
            take(&mut rest, ':');
            let minutes = digits(&mut rest, 2)?;
            if !rest.is_empty() || hours > 23 || minutes > 59 {
                return None;
            }
            let offset = hours * 60 + minutes;
            if negative { -offset } else { offset }
        }
    };
    let days = days_from_civil(year, month, 1) + day - 1;
    let time =
        days * 86_400_000 + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000 + millis;
    (time.abs() <= MAX_TIME_MS).then_some(time)
}

/// `Date.prototype.toISOString`: to the millisecond in UTC, a year outside 0 to 9999 signed and
/// six digits long.
pub fn iso_string(millis: i64) -> String {
    let (days, of_day) = (millis.div_euclid(86_400_000), millis.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// Days from 1970-01-01 to a proleptic Gregorian date, for any year a JavaScript `Date` holds
/// (chrono's stop at 262143).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date `days` from 1970-01-01: year, month and day.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node 24's `Date.parse`, then `toISOString`, of each.
    #[test]
    fn instants_are_read_as_v8_reads_them() {
        for (text, expected) in [
            ("2026-02-30T00:00:00Z", Some("2026-03-02T00:00:00.000Z")),
            ("2026-04-31T00:00:00Z", Some("2026-05-01T00:00:00.000Z")),
            ("0000-01-01T00:00:00Z", Some("0000-01-01T00:00:00.000Z")),
            ("2026-01-01T00:00:00z", Some("2026-01-01T00:00:00.000Z")),
            ("2026-01-01T10:00Z", Some("2026-01-01T10:00:00.000Z")),
            ("2026-01-01 10:00:00Z", Some("2026-01-01T10:00:00.000Z")),
            (
                "2026-01-01T10:00:00.123456Z",
                Some("2026-01-01T10:00:00.123Z"),
            ),
            (
                "2026-01-01T10:00:00+05:00",
                Some("2026-01-01T05:00:00.000Z"),
            ),
            ("2026-01-01T24:00:00Z", Some("2026-01-02T00:00:00.000Z")),
            ("2026-01-01Z", Some("2026-01-01T00:00:00.000Z")),
            (
                "2026-01-01T10:00:00.5-05:30",
                Some("2026-01-01T15:30:00.500Z"),
            ),
            ("+002026-01-01T00:00:00Z", Some("2026-01-01T00:00:00.000Z")),
            ("2026-01-01t10:00:00Z", Some("2026-01-01T10:00:00.000Z")),
            (
                "2026-01-01T23:59:59.9999999Z",
                Some("2026-01-01T23:59:59.999Z"),
            ),
            (
                "-000001-01-01T00:00:00Z",
                Some("-000001-01-01T00:00:00.000Z"),
            ),
            (
                "2026-01-01T10:00:00+23:59",
                Some("2025-12-31T10:01:00.000Z"),
            ),
            (
                "+275760-09-13T00:00:00Z",
                Some("+275760-09-13T00:00:00.000Z"),
            ),
            ("2026-13-01T00:00:00Z", None),
            ("2026-01-01T10:00:60Z", None),
            ("2026-1-1T00:00:00Z", None),
            ("2026-01-01T10Z", None),
            ("2026-01-01T10:00:00.Z", None),
            ("2026-01-00T00:00:00Z", None),
            ("2026-01-32T00:00:00Z", None),
            ("2026-01-01T24:30:00Z", None),
            ("2026-01-01T24:00:00.001Z", None),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-01-01T1:00:00Z", None),
            ("2026-01-01T10:00:00 Z", None),
            ("2026-01-01T10:00:00+24:00", None),
            ("2026-01-01T10:00:00+05:60", None),
            ("275760-09-13T00:00:00Z", None),
            ("+275760-09-13T00:00:00.001Z", None),
        ] {
            assert_eq!(
                js_date_parse(text).map(iso_string).as_deref(),
                expected,
                "{text}"
            );
        }
        assert_eq!(
            instant(Some(" 2026-01-01T10:00:00+0500 ")),
            Err("Market evidence instant must be an ISO timestamp with a UTC offset.".to_owned())
        );
        assert_eq!(instant(Some("  ")), Ok(None));
    }

    #[test]
    fn ledger_dates_are_read_as_v8_reads_them() {
        assert!(date_parses("2026-02-30"));
        assert!(date_parses("0000-01-31"));
        for text in [
            "2026-02-32",
            "2026-00-01",
            "2026-13-01",
            "2026-1-01",
            " 2026-01-01",
        ] {
            assert!(!date_parses(text), "{text}");
        }
        assert_eq!(currency(" USD "), Ok("USD".to_owned()));
        assert!(currency("usd").is_err());
    }
}
