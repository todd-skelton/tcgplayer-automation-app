//! The publication repair: an item Seller Portal's answer left ambiguous, confirmed live by the
//! operator who saw its quantity go live there, with when and a note of where
//! ([`confirmation`]). The form sends the quantity seen, the local time it went live (read in the
//! visitor's zone) and the note. Confirmed, the batch's panel and its ambiguous items are drawn
//! again with what it did; refused, the item's form comes back with why, next to the field at
//! fault or at its top.
use chrono::{DateTime, Datelike, NaiveDateTime, TimeDelta, Utc};
use corten::{Mode, Refusal, i18n::Zone, prelude::*};
use corten_ui::Toast;

use super::{
    page::{Drawn, Shown, answer, page, success_rates, unavailable},
    url,
    views::{BatchFollow, BatchProblem, ConfirmForm, Refused},
};
use crate::{
    database::Database,
    features::inventory_publication::confirmation::{self, Confirmation, Confirmed, NotConfirmed},
    text::Msg,
};

/// The most a note of where the item was seen live holds.
pub const MOST_NOTE: usize = 500;
/// The quantities an item can add.
const QUANTITY: Bounds<i32> = Bounds::new(1, i32::MAX);

/// An ambiguous item's confirmation as its form sends it.
#[derive(Clone, Debug, Default, Fields)]
pub struct ConfirmInput {
    pub publication: i64,
    pub item: i64,
    /// The quantity Seller Portal showed going live.
    pub quantity: Entry<i32>,
    /// When, as `<input type="datetime-local">` sends it: `2026-11-13T14:05`, in the visitor's
    /// zone.
    #[serde(default)]
    pub live_at: String,
    /// Where it was seen live.
    #[serde(default)]
    pub note: String,
}

impl ConfirmInput {
    /// A blank form for the item.
    pub fn of(publication: i64, item: i64) -> Self {
        ConfirmInput {
            publication,
            item,
            ..ConfirmInput::default()
        }
    }

    /// The confirmation the form says, read in `zone` at `now`, or what is wrong with it.
    pub fn read(&self, zone: &impl Zone, now: DateTime<Utc>) -> Result<Confirmation, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let quantity = QUANTITY.read(&self.quantity);
        if quantity.is_none() {
            errors.add(
                f.quantity,
                "Enter the whole quantity Seller Portal showed going live.",
            );
        }
        let confirmed_at = local_instant(&self.live_at, zone);
        match confirmed_at {
            None => errors.add(f.live_at, "Enter when Seller Portal showed it live."),
            Some(at) if at > now => {
                errors.add(f.live_at, "The time it went live cannot be in the future.")
            }
            Some(_) => {}
        }
        let note = self.note.trim();
        if note.is_empty() {
            errors.add(
                f.note,
                "Note where you saw it live: the Seller Portal page, a ticket.",
            );
        } else if note.chars().count() > MOST_NOTE {
            errors.add(f.note, format!("Keep the note to {MOST_NOTE} characters."));
        }
        match (quantity, confirmed_at) {
            (Some(quantity), Some(confirmed_at)) if errors.is_empty() => Ok(Confirmation {
                publication_id: self.publication,
                item_id: self.item,
                quantity,
                confirmed_at,
                note: note.to_owned(),
            }),
            _ => Err(errors),
        }
    }
}

/// The instant a `datetime-local` value means in `zone`: `2026-11-13T14:05`, with seconds or
/// without. A time the clocks skip is read at the offset before the change. None for text that
/// is not one, or before 2000, when nothing was published.
pub fn local_instant(text: &str, zone: &impl Zone) -> Option<DateTime<Utc>> {
    let text = text.trim();
    let local = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M"))
        .ok()
        .filter(|local| (2000..=9999).contains(&local.year()))?;
    let as_utc = local.and_utc();
    let offset = |at: DateTime<Utc>| TimeDelta::seconds(zone.offset(at.into()).into());
    let first = as_utc - offset(as_utc);
    Some(as_utc - offset(first))
}

/// Confirms the item in one transaction: all of it is saved, or none.
async fn save(
    db: &Database,
    batch: i32,
    confirmation: &Confirmation,
) -> Result<Confirmed, NotConfirmed> {
    let mut tx = db.0.begin().await?;
    let confirmed = confirmation::confirm(&mut tx, batch, confirmation).await?;
    tx.commit().await?;
    Ok(confirmed)
}

/// What the operator is told a confirmation did.
fn said(confirmed: &Confirmed) -> String {
    let publication = confirmed.publication_id;
    let stands = if confirmed.publication_published {
        format!("Publication {publication} is published.")
    } else {
        let n = confirmed.without_outcome;
        let items = if n == 1 { "item" } else { "items" };
        format!("Publication {publication} still has {n} {items} without an outcome.")
    };
    format!("SKU {} confirmed live. {stands}", confirmed.sku)
}

/// The item confirmed live and the batch drawn again: with JavaScript its panel (its ambiguous
/// items with it) and a toast; without, the page with the notice. A refusal is the item's form
/// with why, or, once the item has no form, why above the batch.
pub async fn confirm_live(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::ConfirmLive>,
    Form(input): Form<ConfirmInput>,
) -> HtmlResult {
    let f = ConfirmInput::FIELDS;
    let errors = match input.read(&req.zone(), Utc::now()) {
        Err(errors) => errors,
        Ok(confirmation) => match save(&db, at.batch, &confirmation).await {
            Ok(confirmed) => return confirmed_live(&req, &db, at.batch, &confirmed).await,
            Err(NotConfirmed::Database(error)) => return Err(error.into()),
            Err(not) => {
                if earliest(&db, at.batch, input.item).await?.is_none() {
                    // Its form is gone, confirmed meanwhile or never ambiguous: why goes above
                    // the batch, as any refused post on it does.
                    return answer(&req, &db, at.batch, Err(not.message())).await;
                }
                let mut errors = Errors::new();
                match not {
                    NotConfirmed::OtherQuantity(_) => errors.add(f.quantity, not.message()),
                    NotConfirmed::TooEarly => errors.add(f.live_at, not.message()),
                    _ => errors.refuse(Refusal::Conflict, not.message()),
                }
                errors
            }
        },
    };
    let earliest = earliest(&db, at.batch, input.item).await?;
    let t: Msg = req.t();
    let form = ConfirmForm {
        batch: at.batch,
        input: &input,
        earliest,
        errors: &errors,
        t,
    };
    let drawn = Drawn {
        refused: Some(Refused {
            input: &input,
            errors: &errors,
        }),
        ..Drawn::default()
    };
    req.invalid(&errors, form, || page(&req, &db, Some(at.batch), &drawn))
        .await
}

/// The earliest time the item can have gone live, while it is still ambiguous.
async fn earliest(db: &Database, batch: i32, item: i64) -> sqlx::Result<Option<DateTime<Utc>>> {
    let mut conn = db.0.acquire().await?;
    let items = confirmation::ambiguous(&mut conn, batch).await?;
    Ok(items
        .iter()
        .find(|ambiguous| ambiguous.item_id == item)
        .map(confirmation::Ambiguous::earliest))
}

async fn confirmed_live(req: &Req, db: &Database, batch: i32, confirmed: &Confirmed) -> HtmlResult {
    let message = said(confirmed);
    if req.mode != Mode::Action {
        return req.redirect_with_notice(&url::BatchPricer::batch(batch), message);
    }
    let t: Msg = req.t();
    let rates = success_rates(db).await?;
    let shown = Shown::read(db, batch, rates).await.map_err(unavailable)?;
    req.patch(html! {
        <BatchFollow shown={&shown} refused={None} t={t} />
        <BatchProblem message={None} />
        <Toast message={Some(message.as_str())} failed={false} />
    })
}

#[cfg(test)]
mod tests {
    use corten::i18n::{Offset, Visitor};

    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn input(quantity: &str, live_at: &str, note: &str) -> ConfirmInput {
        ConfirmInput {
            publication: 7,
            item: 11,
            quantity: Entry::typed(quantity),
            live_at: live_at.into(),
            note: note.into(),
        }
    }

    #[test]
    fn a_local_time_is_the_instant_it_means_in_the_zone() {
        let central = Offset::hours(-6);
        assert_eq!(
            local_instant("2026-11-13T14:05", &central),
            Some(at("2026-11-13T20:05:00Z"))
        );
        assert_eq!(
            local_instant("2026-11-13T14:05:30", &central),
            Some(at("2026-11-13T20:05:30Z"))
        );
        let chicago = Visitor::named("America/Chicago");
        assert_eq!(
            local_instant("2026-07-01T09:00", &chicago),
            Some(at("2026-07-01T14:00:00Z")),
            "daylight saving time"
        );
        assert_eq!(
            local_instant("2026-01-01T09:00", &chicago),
            Some(at("2026-01-01T15:00:00Z"))
        );
        for unreadable in [
            "",
            "yesterday",
            "2026-11-13",
            "1999-12-31T23:59",
            "2026-13-01T00:00",
        ] {
            assert_eq!(local_instant(unreadable, &central), None, "{unreadable}");
        }
    }

    #[test]
    fn a_confirmation_reads_the_quantity_the_time_and_the_note() {
        let now = at("2026-11-13T21:00:00Z");
        let read = input(
            "2",
            "2026-11-13T14:05",
            "  Seen in Seller Portal, Live tab ",
        )
        .read(&Offset::hours(-6), now)
        .unwrap();
        assert_eq!(
            read,
            Confirmation {
                publication_id: 7,
                item_id: 11,
                quantity: 2,
                confirmed_at: at("2026-11-13T20:05:00Z"),
                note: "Seen in Seller Portal, Live tab".into(),
            }
        );
        assert_eq!(
            read.evidence(),
            serde_json::json!({ "source": "operator_confirmation", "note": "Seen in Seller Portal, Live tab" })
        );
    }

    #[test]
    fn each_field_says_what_is_wrong_with_it() {
        let f = ConfirmInput::FIELDS;
        let now = at("2026-11-13T21:00:00Z");
        let utc = Offset::hours(0);
        let errors = input("0", "", " ").read(&utc, now).unwrap_err();
        assert!(errors.has(f.quantity) && errors.has(f.live_at) && errors.has(f.note));
        let errors = input("1.5", "2026-11-13T21:01", "seen")
            .read(&utc, now)
            .unwrap_err();
        assert!(errors.has(f.quantity));
        assert_eq!(
            errors.get(f.live_at),
            Some("The time it went live cannot be in the future.")
        );
        let long = "x".repeat(MOST_NOTE + 1);
        let errors = input("2", "2026-11-13T20:00", &long)
            .read(&utc, now)
            .unwrap_err();
        assert!(!errors.has(f.quantity) && !errors.has(f.live_at) && errors.has(f.note));
    }

    #[test]
    fn the_operator_is_told_where_the_publication_stands() {
        let confirmed = |published, without_outcome| Confirmed {
            publication_id: 4,
            sku: 123,
            publication_published: published,
            without_outcome,
        };
        assert_eq!(
            said(&confirmed(true, 0)),
            "SKU 123 confirmed live. Publication 4 is published."
        );
        assert_eq!(
            said(&confirmed(false, 1)),
            "SKU 123 confirmed live. Publication 4 still has 1 item without an outcome."
        );
    }
}
