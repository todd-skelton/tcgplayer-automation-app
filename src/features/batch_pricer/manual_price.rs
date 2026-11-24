//! A price entered by hand for a SKU the batch's pricing left for manual review
//! ([`manual_price`]): the price and, optionally, where it came from. Entered, the batch's panel is
//! drawn again with the SKU ready to publish and its review count down by one; a price that cannot
//! be read comes back in the SKU's form with why, and one the batch refuses (it is pricing, or the
//! SKU no longer needs review) above the batch.
use chrono::Utc;
use corten::prelude::*;

use super::{
    page::{Drawn, answer, page},
    url,
    views::{PriceForm, Refused},
};
use crate::{
    database::Database,
    features::{
        batch_pricing::manual_price::{self, ManualPrice, NotEntered},
        inventory_economics::details::dollars_to_cents,
        inventory_intake::queue::dollars,
    },
};

/// The most a note of where the price came from holds.
pub const MOST_NOTE: usize = 500;
/// The most a price entered by hand can be: $100,000.00.
const MOST_PRICE_CENTS: i64 = 10_000_000;

/// A SKU's price as its form sends it.
#[derive(Clone, Debug, Default, Fields)]
pub struct ManualPriceInput {
    pub sku: i32,
    /// Dollars as typed: `12.50` or `$12.50`.
    #[serde(default)]
    pub price: String,
    /// Where the price came from.
    #[serde(default)]
    pub note: String,
}

impl ManualPriceInput {
    /// A blank form for the SKU.
    pub fn of(sku: i32) -> Self {
        ManualPriceInput {
            sku,
            ..ManualPriceInput::default()
        }
    }

    /// The price the form says, or what is wrong with it.
    pub fn read(&self) -> Result<ManualPrice, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let typed = self.price.trim().trim_start_matches('$');
        let price_cents = match dollars_to_cents(typed, "Price") {
            Ok(0) => {
                errors.add(f.price, "Enter a price above $0.00.");
                None
            }
            Ok(cents) if cents > MOST_PRICE_CENTS => {
                errors.add(f.price, "Enter a price of at most $100,000.00.");
                None
            }
            Ok(cents) => Some(cents),
            Err(message) => {
                errors.add(f.price, message);
                None
            }
        };
        let note = self.note.trim();
        if note.chars().count() > MOST_NOTE {
            errors.add(f.note, format!("Keep the note to {MOST_NOTE} characters."));
        }
        match price_cents {
            Some(price_cents) if errors.is_empty() => Ok(ManualPrice {
                sku: self.sku,
                price_cents,
                note: note.to_owned(),
            }),
            _ => Err(errors),
        }
    }
}

/// Enters the price in one transaction: the result and the batch's counts, or neither.
async fn save(db: &Database, batch: i32, price: &ManualPrice) -> Result<(), NotEntered> {
    let mut tx = db.0.begin().await?;
    manual_price::enter(&mut tx, batch, price, Utc::now()).await?;
    tx.commit().await?;
    Ok(())
}

/// What the operator is told an entered price did.
fn said(batch: i32, price: &ManualPrice) -> String {
    format!(
        "SKU {} in batch {batch} priced at {} by hand",
        price.sku,
        dollars(price.price_cents)
    )
}

/// The price entered and the batch drawn again with what it did. A price that cannot be read is
/// the SKU's form with why; one the batch refuses is why above the batch.
pub async fn enter_price(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::ManualPrice>,
    Form(input): Form<ManualPriceInput>,
) -> HtmlResult {
    let errors = match input.read() {
        Err(errors) => errors,
        Ok(price) => {
            let done = match save(&db, at.batch, &price).await {
                Ok(()) => Ok(said(at.batch, &price)),
                Err(NotEntered::Database(error)) => return Err(error.into()),
                Err(not) => Err(not.message(at.batch, price.sku)),
            };
            return answer(&req, &db, at.batch, done).await;
        }
    };
    let form = PriceForm {
        batch: at.batch,
        input: &input,
        errors: &errors,
    };
    let drawn = Drawn {
        refused: Some(Refused::Price {
            input: &input,
            errors: &errors,
        }),
        ..Drawn::default()
    };
    req.invalid(&errors, form, || page(&req, &db, Some(at.batch), &drawn))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(price: &str, note: &str) -> ManualPriceInput {
        ManualPriceInput {
            sku: 7,
            price: price.into(),
            note: note.into(),
        }
    }

    #[test]
    fn a_price_is_read_in_dollars_with_or_without_its_sign() {
        assert_eq!(
            input(" $12.5 ", "  Comparable listing ").read().unwrap(),
            ManualPrice {
                sku: 7,
                price_cents: 1250,
                note: "Comparable listing".into(),
            }
        );
        assert_eq!(input("3", "").read().unwrap().price_cents, 300);
        assert_eq!(
            input("100000", "").read().unwrap().price_cents,
            MOST_PRICE_CENTS
        );
    }

    #[test]
    fn a_price_that_cannot_list_is_refused_at_its_field() {
        let f = ManualPriceInput::FIELDS;
        for refused in ["", "0", "0.00", "-1", "1.234", "abc", "100000.01"] {
            let errors = input(refused, "").read().unwrap_err();
            assert!(errors.has(f.price), "{refused}");
        }
        let long = "x".repeat(MOST_NOTE + 1);
        let errors = input("1", &long).read().unwrap_err();
        assert!(!errors.has(f.price) && errors.has(f.note));
    }

    #[test]
    fn the_operator_is_told_the_price_entered() {
        let price = ManualPrice {
            sku: 123,
            price_cents: 450,
            note: String::new(),
        };
        assert_eq!(
            said(8652, &price),
            "SKU 123 in batch 8652 priced at $4.50 by hand"
        );
    }
}
