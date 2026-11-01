//! The seller's eBay listings the slab pricer knows, a page at a time, and what each needs
//! reviewed (`getInventory`). Importing them and tying one to an identity are `inventory_import`.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::identity::{Candidate, SlabIdentity};
use crate::database::Database;

/// Listings a page, as the React panel read them.
pub const PAGE_SIZE: u32 = 25;

#[derive(Debug, Deserialize)]
pub struct InventoryPage {
    pub items: Vec<Listing>,
    pub next: Option<String>,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub id: String,
    pub seller: String,
    /// The eBay item, and the variation of it when the listing has several.
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub variation_key: String,
    pub revision: i64,
    pub state: String,
    pub url: String,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub identity_id: Option<String>,
    #[serde(default)]
    pub identity: Option<ListingIdentity>,
    #[serde(default)]
    pub review_reasons: Vec<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub item_id: String,
    pub title: String,
    pub price: Price,
    pub shipping: Shipping,
    #[serde(default)]
    pub certificate: Option<Certificate>,
    /// What the listing itself says the card and grade are.
    #[serde(default)]
    pub expected: Expected,
    /// What the import found to review on the listing.
    #[serde(default)]
    pub review_reasons: Vec<String>,
}

/// The card and grade a listing's title and specifics name (`ExpectedSlabIdentity`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub name: Option<String>,
    pub game: Option<String>,
    pub language: Option<String>,
    pub set: Option<String>,
    pub card_number: Option<String>,
    pub year: Option<String>,
    pub edition: Option<String>,
    pub finish: Option<String>,
    pub stamp: Option<String>,
    pub grade_number: Option<f64>,
    pub grade_label: Option<String>,
    pub qualifier: Option<String>,
    pub autograph: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
}

/// What the listing charges for shipping, when it says.
#[derive(Clone, Debug, Deserialize)]
pub struct Shipping {
    pub amount: Option<f64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub grader: String,
    pub certificate_number: String,
}

/// The identity the listing is tied to, as the inventory read joins it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingIdentity {
    pub grader: String,
    pub certificate_number: String,
    #[serde(default)]
    pub candidate: Option<Candidate>,
    #[serde(default)]
    pub identity: Option<SlabIdentity>,
    /// What the identity's lookup left to review.
    #[serde(default)]
    pub review_reasons: Vec<String>,
}

impl ListingIdentity {
    /// The identity to compare the listing with: the confirmed one, else the proposal.
    fn shown(&self) -> Option<&SlabIdentity> {
        self.identity
            .as_ref()
            .or(self.candidate.as_ref().map(|c| &c.identity))
    }
}

impl Listing {
    /// The listing's ask in USD, the currency the recommendation is calculated in.
    pub fn ask_in_usd(&self) -> Option<f64> {
        let price = &self.snapshot.price;
        (price.currency == "USD").then_some(price.amount)
    }

    /// The shipping it charges in USD, when it says.
    pub fn shipping_in_usd(&self) -> Option<f64> {
        let shipping = &self.snapshot.shipping;
        shipping
            .amount
            .filter(|_| shipping.currency.as_deref() == Some("USD"))
    }

    /// `PSA 10`, or "Unresolved" until a certificate names the grade.
    pub fn owned_grade(&self) -> String {
        self.identity
            .as_ref()
            .and_then(|i| {
                i.identity
                    .as_ref()
                    .or(i.candidate.as_ref().map(|c| &c.identity))
            })
            .map(|i| format!("{} {}", i.grading.grader, i.grading.encoding))
            .unwrap_or_else(|| "Unresolved".into())
    }
}

/// `textField`: a short value without control characters, trimmed; none when empty.
fn text_field(value: &str, most: usize) -> Result<Option<&str>, String> {
    if value.encode_utf16().count() > most || value.chars().any(|c| c < '\u{20}') {
        return Err("Check the inventory request fields.".to_owned());
    }
    Ok(Some(value.trim()).filter(|v| !v.is_empty()))
}

/// `sellerAccount`: the eBay seller's username, as saved: lower case.
pub fn seller_account(value: &str) -> Result<String, String> {
    let seller = text_field(value, 80)?.map(str::to_lowercase);
    seller
        .filter(|s| {
            s.bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-'))
        })
        .ok_or_else(|| "Enter the eBay seller username.".to_owned())
}

/// `identityConflicts`: where the identity disagrees with what the listing says it is.
fn identity_conflicts(identity: Option<&SlabIdentity>, expected: &Expected) -> Vec<String> {
    let lower = |value: Option<&String>| value.map(|v| v.to_lowercase());
    let wanted = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_lowercase)
    };
    let card = identity.map(|i| &i.card);
    let grading = identity.map(|i| &i.grading);
    let fields = [
        ("name", &expected.name, card.and_then(|c| c.name.as_ref())),
        ("game", &expected.game, card.and_then(|c| c.game.as_ref())),
        (
            "language",
            &expected.language,
            card.and_then(|c| c.language.as_ref()),
        ),
        ("set", &expected.set, card.and_then(|c| c.set.as_ref())),
        (
            "cardNumber",
            &expected.card_number,
            card.and_then(|c| c.card_number.as_ref()),
        ),
        ("year", &expected.year, card.and_then(|c| c.year.as_ref())),
        (
            "edition",
            &expected.edition,
            card.and_then(|c| c.edition.as_ref()),
        ),
        (
            "finish",
            &expected.finish,
            card.and_then(|c| c.finish.as_ref()),
        ),
        (
            "stamp",
            &expected.stamp,
            card.and_then(|c| c.stamp.as_ref()),
        ),
    ];
    let mut conflicts: Vec<String> = fields
        .into_iter()
        .filter(|(_, expected, actual)| wanted(expected).is_some_and(|w| lower(*actual) != Some(w)))
        .map(|(field, _, _)| format!("inventory-{field}-mismatch"))
        .collect();
    if let Some(number) = expected.grade_number
        && grading.and_then(|g| g.number) != Some(number)
    {
        conflicts.push("inventory-grade-mismatch".to_owned());
    }
    for (field, expected, actual) in [
        (
            "gradeLabel",
            &expected.grade_label,
            grading.and_then(|g| g.label.as_ref()),
        ),
        (
            "qualifier",
            &expected.qualifier,
            grading.and_then(|g| g.qualifier.as_ref()),
        ),
        (
            "autograph",
            &expected.autograph,
            grading.and_then(|g| g.autograph.as_ref()),
        ),
    ] {
        if wanted(expected).is_some_and(|w| lower(actual) != Some(w)) {
            conflicts.push(format!("inventory-{field}-mismatch"));
        }
    }
    conflicts
}

/// `reviewInventoryRow`: what the listing needs reviewed, each reason once.
fn review_reasons(
    snapshot: &Snapshot,
    identity: Option<&ListingIdentity>,
    duplicate: bool,
) -> Vec<String> {
    let mut reasons = snapshot.review_reasons.clone();
    if duplicate {
        reasons.push("certificate-used-by-another-active-listing".to_owned());
    }
    match identity {
        Some(identity) => reasons.extend(identity.review_reasons.iter().cloned()),
        None => reasons.push("identity-required".to_owned()),
    }
    reasons.extend(identity_conflicts(
        identity.and_then(ListingIdentity::shown),
        &snapshot.expected,
    ));
    if let (Some(identity), Some(certificate)) = (identity, &snapshot.certificate)
        && (identity.grader != certificate.grader
            || identity.certificate_number != certificate.certificate_number)
    {
        reasons.push("listing-certificate-conflicts-with-manual-identity".to_owned());
    }
    let mut seen = std::collections::HashSet::new();
    reasons.retain(|r| seen.insert(r.clone()));
    reasons
}

/// A listing with the identity it is tied to, and whether another active listing names its
/// certificate (`REVIEW_COLUMNS`).
macro_rules! reviewed {
    ($rest:literal) => {
        concat!(
            r#"SELECT s.id::text, s.seller, s.item_id, s.variation_key, s.snapshot, s.state, s.revision, s.identity_id::text, s.observed_at,
    (SELECT jsonb_build_object('grader', i.grader, 'certificateNumber', i.certificate_number, 'candidate', i.candidate,
      'identity', i.identity, 'reviewReasons', i.review_reasons) FROM slab_identities i WHERE i.id = s.identity_id),
    EXISTS (SELECT 1 FROM slab_inventory other WHERE other.seller = s.seller AND other.id <> s.id AND other.state = 'active'
      AND s.snapshot->'certificate' <> 'null'::jsonb AND other.snapshot->'certificate' = s.snapshot->'certificate')
    FROM slab_inventory s "#,
            $rest
        )
    };
}

const PAGE: &str =
    reviewed!("WHERE seller = $1 AND ($2 = '' OR id > NULLIF($2, '')::uuid) ORDER BY id LIMIT $3");
const ONE: &str = reviewed!("WHERE id = $1::uuid");

type Row = (
    String,
    String,
    String,
    String,
    Value,
    String,
    i32,
    Option<String>,
    DateTime<Utc>,
    Option<Value>,
    bool,
);

/// `reviewInventoryRow`: the listing as saved, with what it needs reviewed.
fn reviewed(row: Row) -> Result<Listing, String> {
    let (
        id,
        seller,
        item_id,
        variation_key,
        snapshot,
        state,
        revision,
        identity_id,
        observed_at,
        identity,
        duplicate,
    ) = row;
    let unreadable = |e: serde_json::Error| format!("Listing {id} could not be read: {e}");
    let snapshot: Snapshot = serde_json::from_value(snapshot).map_err(unreadable)?;
    let identity: Option<ListingIdentity> = identity
        .map(serde_json::from_value)
        .transpose()
        .map_err(unreadable)?;
    Ok(Listing {
        review_reasons: review_reasons(&snapshot, identity.as_ref(), duplicate),
        url: format!("https://www.ebay.com/itm/{item_id}"),
        id,
        seller,
        item_id,
        variation_key,
        revision: i64::from(revision),
        state,
        snapshot,
        identity_id,
        identity,
        observed_at: observed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

/// `getInventoryListing`: one listing, with what it needs reviewed.
pub(super) async fn listing(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<Listing>, String> {
    let valid = id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'));
    if !valid {
        return Err("Choose an inventory listing.".to_owned());
    }
    let row: Option<Row> = sqlx::query_as(ONE)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    row.map(reviewed).transpose()
}

/// `getInventory`: `limit` of the seller's listings after the listing `after` (none for the
/// first), the next page's start, and the account's revision.
async fn read(
    conn: &mut sqlx::PgConnection,
    seller: &str,
    after: &str,
    limit: u32,
) -> Result<InventoryPage, String> {
    let after_ok = after.is_empty()
        || (after.len() == 36
            && after
                .bytes()
                .all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-')));
    if !(1..=200).contains(&limit) || !after_ok {
        return Err("Invalid inventory page.".to_owned());
    }
    let seller = seller_account(seller)?;
    let failed = |e: sqlx::Error| e.to_string();
    let rows: Vec<Row> = sqlx::query_as(PAGE)
        .bind(&seller)
        .bind(after)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(failed)?;
    let more = rows.len() > limit as usize;
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(reviewed)
        .collect::<Result<Vec<_>, String>>()?;
    let revision: Option<i32> =
        sqlx::query_scalar("SELECT revision FROM slab_inventory_accounts WHERE seller = $1")
            .bind(&seller)
            .fetch_optional(&mut *conn)
            .await
            .map_err(failed)?;
    Ok(InventoryPage {
        next: if more {
            items.last().map(|l| l.id.clone())
        } else {
            None
        },
        items,
        revision: revision.map_or(0, i64::from),
    })
}

/// One page of the seller's listings, after the listing `after` (none for the first).
pub async fn page(db: &Database, seller: &str, after: &str) -> Result<InventoryPage, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    read(&mut conn, seller, after, PAGE_SIZE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases in `.port-logs/slab-inventory-cases.json` on the listings `slab-inventory-seed.sql`
    /// saves, in a transaction rolled back, against Node's `getInventory`
    /// (`.port-logs/slab-inventory-node.ts`). A field Node refuses (`SlabIdentityError`) is
    /// answered as its route answered it.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn pages_read_as_node_reads_them() {
        #[derive(Deserialize)]
        struct Case {
            seller: String,
            after: String,
            limit: u32,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Case> =
            serde_json::from_str(&read_log("slab-inventory-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("slab-inventory.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("slab-inventory-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let shown = format!("{:?} after {:?} by {}", case.seller, case.after, case.limit);
            let ours = read(&mut tx, &case.seller, &case.after, case.limit).await;
            let ours = match ours {
                Err(error) => {
                    let expected = match theirs["refused"].as_str() {
                        Some("SlabIdentityError") => "Check the inventory request fields.",
                        _ => theirs["error"].as_str().unwrap(),
                    };
                    assert_eq!(error, expected, "{shown}");
                    continue;
                }
                Ok(ours) => ours,
            };
            assert!(
                theirs["error"].is_null(),
                "{shown}: Node refused with {}",
                theirs["error"]
            );
            assert_eq!(ours.next.as_deref(), theirs["next"].as_str(), "{shown}");
            assert_eq!(ours.revision, theirs["revision"], "{shown}");
            let items = theirs["items"].as_array().unwrap();
            assert_eq!(ours.items.len(), items.len(), "{shown}");
            for (listing, their) in ours.items.iter().zip(items) {
                let at = format!("{shown}, listing {}", listing.id);
                assert_eq!(listing.id, their["id"], "{at}");
                assert_eq!(listing.seller, their["seller"], "{at}");
                assert_eq!(listing.revision, their["revision"], "{at}");
                assert_eq!(listing.state, their["state"], "{at}");
                assert_eq!(listing.url, their["url"], "{at}");
                assert_eq!(
                    listing.identity_id.as_deref(),
                    their["identityId"].as_str(),
                    "{at}"
                );
                assert_eq!(listing.observed_at, their["observedAt"], "{at}");
                assert_eq!(listing.snapshot.title, their["snapshot"]["title"], "{at}");
                let reasons: Vec<String> =
                    serde_json::from_value(their["reviewReasons"].clone()).unwrap();
                assert_eq!(listing.review_reasons, reasons, "{at}");
                assert_eq!(
                    listing
                        .identity
                        .as_ref()
                        .map(|i| (i.grader.as_str(), i.certificate_number.as_str())),
                    their["identity"].as_object().map(|i| (
                        i["grader"].as_str().unwrap(),
                        i["certificateNumber"].as_str().unwrap()
                    )),
                    "{at}"
                );
            }
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn a_listing_names_its_owned_grade_once_a_certificate_does() {
        let listing: Listing = serde_json::from_str(
            r#"{"id":"1","seller":"pokebash","revision":2,"state":"active","url":"https://www.ebay.com/itm/9",
                "snapshot":{"itemId":"123456789","title":"Charizard PSA 9","price":{"amount":420.5,"currency":"USD"},
                    "shipping":{"amount":5,"currency":"USD","policyId":null},"certificate":null},
                "identityId":null,"identity":null,"reviewReasons":["identity-required"],
                "observedAt":"2026-10-30T12:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(listing.owned_grade(), "Unresolved");
        assert_eq!(listing.ask_in_usd(), Some(420.5));
        assert_eq!(listing.shipping_in_usd(), Some(5.0));
        let tied: ListingIdentity = serde_json::from_str(
            r#"{"grader":"PSA","certificateNumber":"5","candidate":null,"identity":{"card":{"name":"Charizard"},"grading":{"grader":"PSA","encoding":"9","number":9,"label":"MINT","qualifier":null,"autograph":null}}}"#,
        )
        .unwrap();
        let listing = Listing {
            identity: Some(tied),
            ..listing
        };
        assert_eq!(listing.owned_grade(), "PSA 9");
    }
}
