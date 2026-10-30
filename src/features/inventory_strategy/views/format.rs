//! How the screen writes its numbers, as the React components did (`format.ts` and the helpers
//! each component kept): fixed digits as JavaScript's `toFixed` rounds them, money in dollars.
use chrono::{DateTime, NaiveDate, Utc};
use corten::i18n::{Currency, Minor};

use crate::{features::inventory_economics::ledger::assumptions::js_to_fixed, text::Msg};

pub const USD: Currency = Currency::new("USD");

/// `value.toFixed(digits)`.
pub fn fixed(value: f64, digits: usize) -> String {
    js_to_fixed(value, digits)
}

/// An amount of cents, as dollars: "$1,234.50".
pub fn cents(t: Msg, cents: i64) -> String {
    t.money(Minor(cents), USD).to_string()
}

/// An amount of dollars: "$1,234.50".
pub fn dollars(t: Msg, dollars: f64) -> String {
    t.money(Minor((dollars * 100.0).round() as i64), USD)
        .to_string()
}

/// An amount of dollars with its sign: "+$12.00", "-$3.10".
pub fn signed_dollars(t: Msg, dollars: f64) -> String {
    t.signed_money(Minor((dollars * 100.0).round() as i64), USD)
        .to_string()
}

/// A whole number with its separators: "1,234".
pub fn count(t: Msg, n: i64) -> String {
    t.number(n).to_string()
}

/// "12.3%", or `none` without a value.
pub fn percent(value: Option<f64>, none: &str) -> String {
    value.map_or_else(|| none.to_owned(), |v| format!("{}%", fixed(v, 1)))
}

/// A daily return already in percent: "0.52%/day", or `none`.
pub fn percent_per_day(value: Option<f64>, none: &str) -> String {
    value.map_or_else(|| none.to_owned(), |v| format!("{}%/day", fixed(v, 2)))
}

/// A daily return as a fraction: 0.0052 is "0.52%/day".
pub fn per_day(fraction: f64) -> String {
    format!("{}%/day", fixed(fraction * 100.0, 2))
}

/// "3.4 days", or `none`.
pub fn days(value: Option<f64>, none: &str) -> String {
    value.map_or_else(|| none.to_owned(), |v| format!("{} days", fixed(v, 1)))
}

/// "+1.2 days", "−0.5 days", with the minus sign the React screen used.
pub fn days_delta(days: f64) -> String {
    let sign = if days >= 0.0 { "+" } else { "\u{2212}" };
    format!("{sign}{} days", fixed(days.abs(), 1))
}

/// Modeled units over all units: "87%".
pub fn coverage(modeled: i64, total: i64) -> String {
    if total == 0 {
        return "0%".into();
    }
    format!("{}%", ((modeled as f64 / total as f64) * 100.0).round())
}

/// How old a saved curve is: "Less than 1 hour", "5 hours", "3 days", or none saved.
pub fn age(at: Option<&str>, now: DateTime<Utc>) -> String {
    let Some(at) = at.and_then(|a| a.parse::<DateTime<Utc>>().ok()) else {
        return "No saved curve".into();
    };
    let hours = ((now - at).num_milliseconds() as f64 / 3_600_000.0).max(0.0);
    let plural = |n: f64, unit: &str| format!("{n} {unit}{}", if n == 1.0 { "" } else { "s" });
    if hours < 1.0 {
        "Less than 1 hour".into()
    } else if hours < 48.0 {
        plural(hours.round(), "hour")
    } else {
        plural((hours / 24.0).round(), "day")
    }
}

/// A UTC day as a chart labels it: "Mar 2". By hand: corten's dates have no month-and-day style
/// (corten issue: month and day without the year).
pub fn month_day(day: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    use chrono::Datelike;
    match NaiveDate::parse_from_str(day, "%Y-%m-%d") {
        Ok(d) => format!("{} {}", MONTHS[d.month0() as usize], d.day()),
        Err(_) => day.to_owned(),
    }
}

/// An instant written as the Node app writes one (ISO 8601), as a time to format.
pub fn instant(at: &str) -> Option<DateTime<Utc>> {
    at.parse().ok()
}

/// A status as words: "unsettled_outcomes" is "unsettled outcomes".
pub fn words(status: &str) -> String {
    status.replace(['_', '-'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_as_the_react_screen_wrote_them() {
        assert_eq!(percent(Some(12.25), "N/A"), "12.3%");
        assert_eq!(percent(None, "N/A"), "N/A");
        assert_eq!(per_day(0.0052), "0.52%/day");
        assert_eq!(days_delta(-0.25), "\u{2212}0.3 days");
        assert_eq!(days_delta(1.0), "+1.0 days");
        assert_eq!(coverage(87, 100), "87%");
        assert_eq!(coverage(1, 0), "0%");
        assert_eq!(month_day("2026-03-02"), "Mar 2");
    }

    #[test]
    fn a_curves_age_is_hours_then_days() {
        let now: DateTime<Utc> = "2026-10-30T12:00:00Z".parse().unwrap();
        assert_eq!(age(None, now), "No saved curve");
        assert_eq!(age(Some("2026-10-30T11:30:00Z"), now), "Less than 1 hour");
        assert_eq!(age(Some("2026-10-30T11:00:00Z"), now), "1 hour");
        assert_eq!(age(Some("2026-10-29T12:00:00Z"), now), "24 hours");
        assert_eq!(age(Some("2026-10-27T12:00:00Z"), now), "3 days");
    }
}
