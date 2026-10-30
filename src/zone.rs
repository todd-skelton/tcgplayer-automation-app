//! Dates in the visitor's time zone, as the React screens wrote them with `toLocaleString`. The
//! browser names its zone (`App::client_zone` keeps it in a cookie); a first visit, or a browser
//! without JavaScript, has not named one yet and reads UTC.
use std::time::SystemTime;

use chrono::{DateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use corten::{ClientZone, i18n::Zone};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Visitor(Tz);

impl Visitor {
    pub fn of(zone: Option<&ClientZone>) -> Self {
        Visitor(zone.and_then(|z| z.0.parse().ok()).unwrap_or(Tz::UTC))
    }
}

impl Zone for Visitor {
    fn offset(&self, at: SystemTime) -> i32 {
        let at: DateTime<Utc> = at.into();
        self.0
            .offset_from_utc_datetime(&at.naive_utc())
            .fix()
            .local_minus_utc()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_zone_has_its_offset_at_the_instant() {
        let chicago = Visitor::of(Some(&ClientZone("America/Chicago".into())));
        let summer: DateTime<Utc> = "2026-07-01T12:00:00Z".parse().unwrap();
        let winter: DateTime<Utc> = "2026-12-01T12:00:00Z".parse().unwrap();
        assert_eq!(chicago.offset(summer.into()), -5 * 3600);
        assert_eq!(chicago.offset(winter.into()), -6 * 3600);
    }

    #[test]
    fn no_zone_or_an_unknown_one_is_utc() {
        assert_eq!(Visitor::of(None), Visitor(Tz::UTC));
        assert_eq!(
            Visitor::of(Some(&ClientZone("Mars/Base".into()))),
            Visitor(Tz::UTC)
        );
    }
}
