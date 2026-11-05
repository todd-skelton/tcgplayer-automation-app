//! Importing purchase costs from a CSV file, ported from the Node app's
//! `purchaseCostFileImport.server.ts`: up to 25 rows, each a purchase split across its batches'
//! lots by quantity, all recorded in one transaction or none. A row's request id is the file's
//! content fingerprint and its place, so importing the same file again repeats every row.
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    details::{
        calendar_date, date_parses, distinct, dollars_to_cents, postgres_integer, required_text,
    },
    estimate::PurchaseCost,
    ledger::fingerprint::sha256_hex,
    purchase_cost,
    series::{NotRecorded, failed},
};
use crate::api::{js_number, js_trim};

/// The largest file read: 256 KB.
pub const MAX_CSV_BYTES: usize = 256 * 1024;

/// The most rows a file records.
const MAX_ROWS: usize = 25;

/// The header a file starts with.
pub const HEADER: &str = "Purchase Reference,Batch Numbers,Total Amount,Provenance,Allocation Rule,Purchased At,Currency";

/// A row read from the file, its batch numbers as JavaScript read them (checked as Postgres
/// integers only when it is recorded).
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub cost: PurchaseCost,
    pub batch_numbers: Vec<f64>,
}

/// `parsePurchaseCostCsv`: each row the file names, or the first thing wrong with it.
pub fn parse(seller_key: &str, csv_text: &str) -> Result<Vec<Row>, String> {
    if csv_text.len() > MAX_CSV_BYTES {
        return Err("Purchase cost CSV exceeds 256 KB.".to_owned());
    }
    let normalized = csv_text
        .strip_prefix('\u{feff}')
        .unwrap_or(csv_text)
        .replace("\r\n", "\n");
    let normalized = js_trim(&normalized);
    let mut lines = normalized
        .split('\n')
        .filter(|line| !js_trim(line).is_empty());
    if lines.next().map(js_trim) != Some(HEADER) {
        return Err(format!("CSV header must be: {HEADER}"));
    }
    let lines: Vec<&str> = lines.collect();
    if lines.is_empty() || lines.len() > MAX_ROWS {
        return Err(format!("CSV must contain 1 to {MAX_ROWS} rows."));
    }
    let content = sha256_hex(normalized);
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let row = index + 2;
            let columns: Vec<&str> = line.split(',').map(js_trim).collect();
            let [reference, batches, total, provenance, rule, purchased_at, currency] = columns[..]
            else {
                return Err(format!("CSV row {row} must contain seven columns."));
            };
            let batch_numbers: Vec<f64> = batches
                .split(['|', ';'])
                .map(|n| js_number(n).unwrap_or(f64::NAN))
                .collect();
            if batch_numbers
                .iter()
                .any(|n| !n.is_finite() || n.fract() != 0.0 || *n <= 0.0)
            {
                return Err(format!(
                    "CSV row {row}: Batch Numbers must use positive integers separated by |."
                ));
            }
            if reference.is_empty() {
                return Err(format!("CSV row {row}: Purchase Reference is required."));
            }
            let provenance = match provenance {
                "actual" => "actual",
                "estimated" => "estimated",
                _ => {
                    return Err(format!(
                        "CSV row {row}: Provenance must be actual or estimated."
                    ));
                }
            };
            if rule != "quantity" {
                return Err(format!("CSV row {row}: File imports support quantity allocation; frozen market weights require manual dated evidence."));
            }
            if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
                return Err(format!(
                    "CSV row {row}: Currency must be a three-letter uppercase code."
                ));
            }
            let total_amount_cents =
                dollars_to_cents(total, &format!("CSV row {row}: Total Amount"))?;
            if !purchased_at.is_empty() && !date_parses(purchased_at) {
                return Err(format!(
                    "CSV row {row}: Purchased At must be YYYY-MM-DD or blank."
                ));
            }
            Ok(Row {
                cost: PurchaseCost {
                    request_id: format!("purchase-cost-import:{content}:{}", index + 1),
                    seller_key: seller_key.to_owned(),
                    purchase_reference: reference.to_owned(),
                    currency: currency.to_owned(),
                    total_amount_cents,
                    provenance,
                    source: "file_import",
                    allocation_rule: "quantity",
                    batch_numbers: Vec::new(),
                    purchased_at: (!purchased_at.is_empty()).then(|| purchased_at.to_owned()),
                    market_observed_at: None,
                    explicit_allocations: Vec::new(),
                    corrects_entry_id: None,
                    correction_reason: None,
                },
                batch_numbers,
            })
        })
        .collect()
}

/// `importPurchaseCostCsv`: every row recorded in one transaction on `conn`, as
/// `{ rows, repeated }` (repeated when every row was).
pub async fn import(
    conn: &mut PgConnection,
    seller_key: &str,
    csv_text: &str,
) -> Result<Value, NotRecorded> {
    let rows = parse(seller_key, csv_text)?;
    let mut tx = conn.begin().await.map_err(failed)?;
    let mut repeated = true;
    for row in &rows {
        let cost = recordable(row)?;
        repeated &= purchase_cost::record(&mut tx, &cost).await?.repeated;
    }
    tx.commit().await.map_err(failed)?;
    Ok(json!({ "rows": rows.len(), "repeated": repeated }))
}

/// The row as `recordPurchaseCost` checks it before recording: `normalizePurchaseCostDetails`
/// (a real calendar date, references of at most 200 characters), then its batch numbers.
fn recordable(row: &Row) -> Result<PurchaseCost, String> {
    let mut cost = row.cost.clone();
    cost.purchased_at = calendar_date(cost.purchased_at.as_deref())?;
    cost.request_id = required_text(&cost.request_id, "Request ID")?;
    cost.seller_key = required_text(&cost.seller_key, "Seller key")?;
    cost.purchase_reference = required_text(&cost.purchase_reference, "Purchase reference")?;
    let batches = distinct(&row.batch_numbers);
    if batches.is_empty() || batches.len() > 100 {
        return Err("Purchase costs require 1 to 100 positive batch numbers.".to_owned());
    }
    cost.batch_numbers = batches
        .into_iter()
        .map(postgres_integer)
        .collect::<Result<_, _>>()?;
    Ok(cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_read_as_node_reads_it() {
        let csv = format!("\u{feff}{HEADER}\r\n\r\n ref-1 , 7|0x8;9 ,12.5,actual,quantity,,USD\n");
        let rows = parse("seller", &csv).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].batch_numbers, [7.0, 8.0, 9.0]);
        assert_eq!(rows[0].cost.total_amount_cents, 1250);
        assert_eq!(rows[0].cost.purchase_reference, "ref-1");
        assert!(rows[0].cost.request_id.starts_with("purchase-cost-import:"));
        assert_eq!(
            parse(
                "seller",
                &format!("{HEADER}\nref,7,1,actual,quantity,2026-02-30,USD")
            )
            .map(|r| r.len()),
            Ok(1)
        );
        assert_eq!(
            parse(
                "seller",
                &format!("{HEADER}\nref,7,1,actual,quantity,2026-02-32,USD")
            ),
            Err("CSV row 2: Purchased At must be YYYY-MM-DD or blank.".to_owned())
        );
        assert_eq!(
            parse("seller", "nope"),
            Err(format!("CSV header must be: {HEADER}"))
        );
        assert_eq!(
            parse(
                "seller",
                &format!("{HEADER}\nref,7||8,1,actual,quantity,,USD")
            ),
            Err("CSV row 2: Batch Numbers must use positive integers separated by |.".to_owned())
        );
    }
}
