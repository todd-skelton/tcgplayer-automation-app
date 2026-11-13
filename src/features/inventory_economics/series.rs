//! An economics ledger's series, ported from the Node repository's `findRepeatedRequest`,
//! `lockSeries` and `nextCorrection`. The app records only purchase costs; the funding and order
//! expense ledgers it reads were written by the retired `/api` route.
//!
//! Each piece of evidence is a series (a seller's reference in one currency) of immutable entries:
//! the first records it, each later one corrects the series' current entry and says why. A request
//! is recorded once: its id with the same fingerprint is answered with the entry already saved,
//! and with another fingerprint is refused.
use sqlx::PgConnection;

use super::details::required_text;

/// Why evidence was not recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotRecorded {
    /// It conflicts with what is recorded: a request id reused for other evidence, a correction
    /// of an entry that is not the current one, or a lot another purchase owns. Node's
    /// `InventoryEconomicsConflictError`.
    Conflict(String),
    /// Anything else: input it does not take, lots it cannot find, the database failing.
    Failed(String),
}

impl From<&str> for NotRecorded {
    fn from(message: &str) -> Self {
        NotRecorded::Failed(message.to_owned())
    }
}

impl From<String> for NotRecorded {
    fn from(message: String) -> Self {
        NotRecorded::Failed(message)
    }
}

impl From<NotRecorded> for String {
    fn from(not: NotRecorded) -> Self {
        match not {
            NotRecorded::Conflict(message) | NotRecorded::Failed(message) => message,
        }
    }
}

/// The database's failure as Node's route answered it: the error's `message`.
pub fn failed(e: sqlx::Error) -> NotRecorded {
    NotRecorded::Failed(match e.as_database_error() {
        Some(database) => database.message().to_owned(),
        None => e.to_string(),
    })
}

/// The entry a request saved, or found already saved for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    pub entry_id: String,
    pub repeated: bool,
}

/// One of the ledgers: its tables and what names a series in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ledger {
    PurchaseCosts,
}

impl Ledger {
    fn entries(self) -> &'static str {
        match self {
            Ledger::PurchaseCosts => "inventory_purchase_cost_entries",
        }
    }

    fn series(self) -> &'static str {
        match self {
            Ledger::PurchaseCosts => "inventory_purchase_cost_series",
        }
    }

    fn reference(self) -> &'static str {
        match self {
            Ledger::PurchaseCosts => "purchase_reference",
        }
    }
}

/// `findRepeatedRequest`: holds the request id's lock for the transaction, then the entry it
/// already saved, or the refusal when that entry is other evidence.
pub async fn repeated(
    conn: &mut PgConnection,
    ledger: Ledger,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<Saved>, NotRecorded> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("inventory-economics:{request_id}"))
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    let saved: Option<(String, String)> = sqlx::query_as(&format!(
        "SELECT id::text, request_fingerprint FROM {} WHERE request_id=$1",
        ledger.entries()
    ))
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    match saved {
        Some((_, saved)) if saved != fingerprint => Err(NotRecorded::Conflict(
            "Request ID was already used for different inventory economics evidence.".into(),
        )),
        Some((entry_id, _)) => Ok(Some(Saved {
            entry_id,
            repeated: true,
        })),
        None => Ok(None),
    }
}

/// `lockSeries`: the series of `reference`, made when it is new, locked for the transaction.
pub async fn lock_series(
    conn: &mut PgConnection,
    ledger: Ledger,
    seller_key: &str,
    reference: &str,
    currency: &str,
) -> Result<String, NotRecorded> {
    let (series, column) = (ledger.series(), ledger.reference());
    sqlx::query(&format!(
        "INSERT INTO {series} (seller_key,{column},currency) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING"
    ))
    .bind(seller_key)
    .bind(reference)
    .bind(currency)
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    let id: Option<String> = sqlx::query_scalar(&format!(
        "SELECT id::text FROM {series} WHERE seller_key=$1 AND {column}=$2 AND currency=$3 FOR UPDATE"
    ))
    .bind(seller_key)
    .bind(reference)
    .bind(currency)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    id.ok_or_else(|| format!("Failed to establish {}.", column.replace('_', " ")).into())
}

/// Where a new entry goes in its series: its place, and the current entry it corrects and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Correction {
    pub sequence: i32,
    pub corrects_entry_id: Option<String>,
    pub reason: Option<String>,
}

/// Text JavaScript counts as given: not blank.
fn given(text: Option<&str>) -> Option<&str> {
    text.filter(|t| !t.is_empty())
}

/// `nextCorrection`: the first entry of a new series, or a correction of the current entry,
/// which must name it and give a reason.
pub async fn next_correction(
    conn: &mut PgConnection,
    ledger: Ledger,
    series_id: &str,
    corrects_entry_id: Option<&str>,
    correction_reason: Option<&str>,
) -> Result<Correction, NotRecorded> {
    let current: Option<(String, i32)> = sqlx::query_as(&format!(
        "SELECT id::text,sequence FROM {} WHERE series_id=$1::bigint ORDER BY sequence DESC LIMIT 1",
        ledger.entries()
    ))
    .bind(series_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    let Some((id, sequence)) = current else {
        if given(corrects_entry_id).is_some() || given(correction_reason).is_some() {
            return Err(NotRecorded::Conflict(
                "An initial entry cannot be a correction.".into(),
            ));
        }
        return Ok(Correction {
            sequence: 1,
            corrects_entry_id: None,
            reason: None,
        });
    };
    if given(corrects_entry_id) != Some(id.as_str()) {
        return Err(NotRecorded::Conflict(format!(
            "A correction must reference the current entry {id}."
        )));
    }
    let reason = required_text(correction_reason.unwrap_or(""), "Correction reason")?;
    Ok(Correction {
        sequence: sequence + 1,
        corrects_entry_id: Some(id),
        reason: Some(reason),
    })
}
