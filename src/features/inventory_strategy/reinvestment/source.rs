//! The evidence the turnaround is rebuilt from (current purchase costs with their publications,
//! funding, receipts with no cost, the latest order sync) and the saved rebuilds: the Node app's
//! `inventoryReinvestmentRepository` and `reinvestmentTurnaround.server.ts`.
use std::collections::HashMap;

use chrono::{DateTime, Timelike, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, types::Json};

use super::*;
use crate::{
    database::Database,
    features::{
        inventory_economics::ledger::{
            fingerprint::{sha256_hex, stable_json},
            money::allocate as split,
            proceeds::{self, CompleteReusableProceeds, iso},
        },
        inventory_strategy::collate,
    },
};

const FENCE: usize = 10_000;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct PurchaseRow {
    pub purchase_reference: String,
    pub currency: String,
    pub total_amount_cents: i64,
    pub cost_provenance: String,
    pub purchased_at: Option<String>,
    pub cost_source_identity: String,
    pub receipt_id: i32,
    pub product_line_id: i32,
    pub allocated_amount_cents: i64,
    pub original_quantity: i32,
    pub publication_item_id: Option<String>,
    pub planned_quantity: Option<i32>,
    pub live_at: Option<DateTime<Utc>>,
    pub publication_state: Option<String>,
    pub publication_identity: Option<Json<Value>>,
}

impl PurchaseRow {
    /// The row as the Node app holds it, for its identity.
    fn json(&self) -> Value {
        json!({
            "purchaseReference": self.purchase_reference,
            "currency": self.currency,
            "totalAmountCents": self.total_amount_cents,
            "costProvenance": self.cost_provenance,
            "purchasedAt": self.purchased_at,
            "costSourceIdentity": self.cost_source_identity,
            "receiptId": self.receipt_id,
            "productLineId": self.product_line_id,
            "allocatedAmountCents": self.allocated_amount_cents,
            "originalQuantity": self.original_quantity,
            "publicationItemId": self.publication_item_id,
            "plannedQuantity": self.planned_quantity,
            "liveAt": self.live_at.map(iso),
            "publicationState": self.publication_state,
            "publicationIdentity": self.publication_identity.as_ref().map(|j| j.0.clone()),
        })
    }
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct FundingRow {
    pub adjustment_reference: String,
    pub currency: String,
    pub adjustment_type: String,
    pub amount_cents: i64,
    pub provenance: String,
    pub effective_at: String,
    pub purchase_reference: Option<String>,
    pub source_identity: String,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct UnknownCostRow {
    pub receipt_id: i32,
    pub product_line_id: i32,
    pub identity: Json<Value>,
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
struct SyncRun {
    run_id: String,
    search_range: Option<String>,
    finished_at: DateTime<Utc>,
    next_offset: i32,
    expected_total: Option<i32>,
    orders_observed: i32,
    details_recorded: i32,
    observed_from: Option<DateTime<Utc>>,
    observed_through: Option<DateTime<Utc>>,
    gaps: Option<Json<Value>>,
}

pub struct SourceEvidence {
    pub purchase_rows: Vec<PurchaseRow>,
    pub funding_rows: Vec<FundingRow>,
    pub unknown_cost_receipts: Vec<UnknownCostRow>,
    pub order_coverage: Option<OrderCoverage>,
}

fn fenced<T>(rows: Vec<T>, source: &str) -> Result<Vec<T>, String> {
    if rows.len() > FENCE {
        return Err(format!(
            "{source} exceeds the 10,000-row complete-evidence fence."
        ));
    }
    Ok(rows)
}

pub async fn find_source_evidence(
    conn: &mut PgConnection,
    seller: &str,
) -> Result<SourceEvidence, String> {
    let e = |e: sqlx::Error| e.to_string();
    let purchase_rows: Vec<PurchaseRow> = sqlx::query_as(
        r#"WITH current_cost AS (
            SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id,entry.total_amount_cents,entry.provenance,
              entry.purchased_at,entry.request_fingerprint
            FROM inventory_purchase_cost_entries entry ORDER BY entry.series_id,entry.sequence DESC
          ) SELECT series.purchase_reference,series.currency,
            current.total_amount_cents::bigint AS total_amount_cents,current.provenance AS cost_provenance,
            current.purchased_at::text AS purchased_at,current.request_fingerprint AS cost_source_identity,
            allocation.receipt_id,receipt.product_line_id,
            allocation.allocated_amount_cents::bigint AS allocated_amount_cents,
            receipt.original_quantity,link.publication_item_id::text AS publication_item_id,
            link.planned_quantity,link.live_at,item.status AS publication_state,
            CASE WHEN link.publication_item_id IS NULL THEN NULL ELSE jsonb_build_object(
              'publicationItemId',link.publication_item_id,'state',item.status,'plannedQuantity',link.planned_quantity,
              'liveAt',link.live_at,'confirmation',link.confirmation_evidence) END AS publication_identity
          FROM inventory_purchase_cost_series series
          JOIN current_cost current ON current.series_id=series.id
          JOIN inventory_purchase_cost_allocations allocation ON allocation.entry_id=current.id
          JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
          LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
            AND link.target_seller_key=series.seller_key
          LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
          WHERE series.seller_key=$1 AND receipt.receipt_kind='received'
            AND NOT EXISTS (
              SELECT 1 FROM inventory_purchase_cost_allocations invalid_allocation
              JOIN inventory_receipts invalid_receipt ON invalid_receipt.receipt_id=invalid_allocation.receipt_id
              WHERE invalid_allocation.entry_id=current.id AND invalid_receipt.receipt_kind<>'received'
            )
          ORDER BY series.currency,current.purchased_at NULLS LAST,series.purchase_reference,allocation.receipt_id
          LIMIT 10001"#,
    )
    .bind(seller)
    .fetch_all(&mut *conn)
    .await
    .map_err(e)?;
    let funding_rows: Vec<FundingRow> = sqlx::query_as(
        r#"WITH current_funding AS (
            SELECT DISTINCT ON (entry.series_id) entry.*
            FROM inventory_funding_entries entry ORDER BY entry.series_id,entry.sequence DESC
          ) SELECT series.adjustment_reference,series.currency,
            current.adjustment_type,current.amount_cents::bigint AS amount_cents,
            current.provenance,current.effective_at::text AS effective_at,
            current.purchase_reference,current.request_fingerprint AS source_identity
          FROM inventory_funding_series series JOIN current_funding current ON current.series_id=series.id
          WHERE series.seller_key=$1
          ORDER BY series.currency,current.effective_at,series.adjustment_reference LIMIT 10001"#,
    )
    .bind(seller)
    .fetch_all(&mut *conn)
    .await
    .map_err(e)?;
    let unknown: Vec<UnknownCostRow> = sqlx::query_as(
        r#"WITH current_cost AS (
            SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id
            FROM inventory_purchase_cost_entries entry ORDER BY entry.series_id,entry.sequence DESC
          ), costed AS (
            SELECT allocation.receipt_id FROM inventory_purchase_cost_series series
            JOIN current_cost current ON current.series_id=series.id
            JOIN inventory_purchase_cost_allocations allocation ON allocation.entry_id=current.id
            WHERE series.seller_key=$1 AND NOT EXISTS (
              SELECT 1 FROM inventory_purchase_cost_allocations invalid_allocation
              JOIN inventory_receipts invalid_receipt ON invalid_receipt.receipt_id=invalid_allocation.receipt_id
              WHERE invalid_allocation.entry_id=current.id AND invalid_receipt.receipt_kind<>'received'
            )
          ) SELECT receipt.receipt_id,receipt.product_line_id,
            jsonb_build_object('receiptId',receipt.receipt_id,'productLineId',receipt.product_line_id,
              'quantity',receipt.original_quantity,
              'sellerKey',receipt.seller_key,'intakeAt',receipt.intake_at,'recordedAt',receipt.recorded_at,
              'sourceEvidence',receipt.source_evidence,'intendedSeller',(
                SELECT intended.target_seller_key FROM inventory_publication_receipt_links intended
                WHERE intended.receipt_id=receipt.receipt_id
              )) AS identity,receipt.intake_at AS occurred_at
            FROM inventory_receipts receipt
            WHERE (receipt.seller_key=$1 OR EXISTS (SELECT 1 FROM inventory_publication_receipt_links intended
                WHERE intended.receipt_id=receipt.receipt_id AND intended.target_seller_key=$1))
              AND receipt.receipt_kind='received'
              AND NOT EXISTS (SELECT 1 FROM costed WHERE costed.receipt_id=receipt.receipt_id)
            ORDER BY receipt.receipt_id LIMIT 10001"#,
    )
    .bind(seller)
    .fetch_all(&mut *conn)
    .await
    .map_err(e)?;
    let run: Option<SyncRun> = sqlx::query_as(
        r#"SELECT id::text AS run_id,search_range,finished_at,next_offset,expected_total,orders_observed,
            details_recorded,observed_from,observed_through,gaps
          FROM seller_order_sync_runs
          WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC,id DESC LIMIT 1"#,
    )
    .bind(seller)
    .fetch_optional(&mut *conn)
    .await
    .map_err(e)?;
    let unknown = fenced(unknown, "Unknown-cost receipt evidence")?;
    Ok(SourceEvidence {
        purchase_rows: fenced(purchase_rows, "Current purchase/publication evidence")?,
        funding_rows: fenced(funding_rows, "Current funding evidence")?,
        unknown_cost_receipts: unknown,
        order_coverage: run.map(|r| OrderCoverage {
            run_id: r.run_id,
            source: "tcgplayer_api".into(),
            status: "complete".into(),
            search_range: r.search_range,
            finished_at: iso(r.finished_at),
            next_offset: r.next_offset.into(),
            expected_total: r.expected_total.map(i64::from),
            orders_observed: r.orders_observed.into(),
            details_recorded: r.details_recorded.into(),
            observed_from: r.observed_from.map(iso),
            observed_through: r.observed_through.map(iso),
            gaps: r
                .gaps
                .and_then(|g| g.0.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .map(|gap| {
                    gap["orderNumber"]
                        .as_str()
                        .unwrap_or("<missing order number>")
                        .to_owned()
                })
                .collect(),
        }),
    })
}

fn identity(value: &Value) -> String {
    sha256_hex(&stable_json(value))
}

fn provenance(value: &str) -> Provenance {
    if value == "estimated" {
        Provenance::Estimated
    } else {
        Provenance::Actual
    }
}

/// A receipt's cost as the parts that went on sale: the planned publication, and any of the
/// lot left out of it, which cannot be followed.
fn publication_tranches(row: &PurchaseRow, allocated: i64) -> Result<Vec<Tranche>, String> {
    let original = i64::from(row.original_quantity);
    let planned = row.planned_quantity.map(i64::from);
    let linked = planned.is_some_and(|p| p > 0 && p <= original);
    let base = |cents: i64, quantity: i64, state: PublicationState| Tranche {
        receipt_id: row.receipt_id.into(),
        product_line_id: row.product_line_id.into(),
        publication_item_id: None,
        amount_cents: cents,
        quantity,
        published_at: None,
        publication_state: state,
        publication_identity: None,
    };
    let publication_identity = row.publication_identity.as_ref().map(|j| identity(&j.0));
    if allocated == 0 {
        let state = if row.live_at.is_some() {
            PublicationState::Confirmed
        } else if linked {
            PublicationState::Waiting
        } else {
            PublicationState::Unsupported
        };
        return Ok(vec![Tranche {
            publication_item_id: row.publication_item_id.clone().filter(|_| linked),
            published_at: row.live_at.map(iso),
            publication_identity,
            ..base(0, original, state)
        }]);
    }
    let Some(planned) = planned.filter(|_| linked) else {
        return Ok(vec![base(
            allocated,
            original,
            PublicationState::Unsupported,
        )]);
    };
    let mut targets = vec![("linked", planned as u64)];
    if original > planned {
        targets.push(("remaining", (original - planned) as u64));
    }
    let amounts: HashMap<String, i64> = split(allocated, &targets)
        .ok_or("Allocation weights must include a positive value.")?
        .into_iter()
        .map(|s| (s.id, s.cents))
        .collect();
    let mut out = vec![Tranche {
        publication_item_id: row.publication_item_id.clone(),
        published_at: row.live_at.map(iso),
        // `identity(row.publicationIdentity)`: a JSON null when there is no link.
        publication_identity: Some(publication_identity.unwrap_or_else(|| identity(&Value::Null))),
        ..base(
            amounts["linked"],
            planned,
            if row.live_at.is_some() {
                PublicationState::Confirmed
            } else {
                PublicationState::Waiting
            },
        )
    }];
    if let Some(&remaining) = amounts.get("remaining") {
        out.push(base(
            remaining,
            original - planned,
            PublicationState::Unsupported,
        ));
    }
    Ok(out)
}

fn adjustment_type(value: &str) -> Option<AdjustmentType> {
    Some(match value {
        "opening_cash" => AdjustmentType::OpeningCash,
        "external_contribution" => AdjustmentType::ExternalContribution,
        "withdrawal" => AdjustmentType::Withdrawal,
        "reserve" => AdjustmentType::Reserve,
        "reserve_release" => AdjustmentType::ReserveRelease,
        _ => return None,
    })
}

/// The allocator's input from the proceeds and the source evidence: `buildReinvestmentInput`.
pub fn build_input(
    seller: &str,
    as_of: &str,
    proceeds: &CompleteReusableProceeds,
    evidence: &SourceEvidence,
) -> Result<Input, String> {
    let key = |currency: &str, reference: &str| format!("{currency}\u{0}{reference}");
    let mut purchase_funding: Vec<(String, Vec<&FundingRow>)> = Vec::new();
    for row in evidence
        .funding_rows
        .iter()
        .filter(|r| r.adjustment_type == "purchase_funding")
    {
        let k = key(
            &row.currency,
            row.purchase_reference.as_deref().unwrap_or(""),
        );
        match purchase_funding.iter_mut().find(|(x, _)| *x == k) {
            Some((_, rows)) => rows.push(row),
            None => purchase_funding.push((k, vec![row])),
        }
    }
    let mut rows_by_key: Vec<(String, Vec<&PurchaseRow>)> = Vec::new();
    for row in &evidence.purchase_rows {
        let k = key(&row.currency, &row.purchase_reference);
        match rows_by_key.iter_mut().find(|(x, _)| *x == k) {
            Some((_, rows)) => rows.push(row),
            None => rows_by_key.push((k, vec![row])),
        }
    }
    let mut purchases = Vec::new();
    for (k, rows) in &rows_by_key {
        let first = rows[0];
        let funding = purchase_funding
            .iter()
            .position(|(x, _)| x == k)
            .map(|i| purchase_funding.remove(i).1)
            .unwrap_or_default();
        let lots: Vec<(i64, i64)> = rows
            .iter()
            .map(|r| (i64::from(r.receipt_id), r.allocated_amount_cents))
            .collect();
        let capital = purchase_capital(&lots);
        let mut tranches = Vec::new();
        for row in rows {
            tranches.extend(publication_tranches(
                row,
                capital.of(row.receipt_id.into()),
            )?);
        }
        purchases.push(Purchase {
            purchase_reference: first.purchase_reference.clone(),
            currency: first.currency.clone(),
            total_amount_cents: capital.total_amount_cents,
            cost_provenance: provenance(&first.cost_provenance),
            cost_source_identity: first.cost_source_identity.clone(),
            purchased_at: first.purchased_at.clone().filter(|p| !p.is_empty()),
            funding: funding
                .iter()
                .map(|f| PurchaseFunding {
                    adjustment_reference: f.adjustment_reference.clone(),
                    amount_cents: f.amount_cents,
                    effective_at: f.effective_at.clone(),
                    provenance: provenance(&f.provenance),
                    source_identity: f.source_identity.clone(),
                })
                .collect(),
            tranches,
        });
    }
    let mut source_evidence_identities: Vec<String> = evidence
        .purchase_rows
        .iter()
        .map(|r| identity(&r.json()))
        .chain(
            evidence
                .funding_rows
                .iter()
                .map(|r| r.source_identity.clone()),
        )
        .chain(
            evidence
                .unknown_cost_receipts
                .iter()
                .map(|r| identity(&r.identity.0)),
        )
        .chain(proceeds.source_evidence_identities.iter().cloned())
        .collect();
    source_evidence_identities.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut unsupported: Vec<UnsupportedFunding> = purchase_funding
        .into_iter()
        .flat_map(|(_, rows)| rows)
        .map(|r| UnsupportedFunding {
            kind: UnsupportedKind::Orphan,
            adjustment_reference: r.adjustment_reference.clone(),
            purchase_reference: r.purchase_reference.clone(),
            currency: r.currency.clone(),
            amount_cents: r.amount_cents,
            effective_at: r.effective_at.clone(),
            source_identity: r.source_identity.clone(),
        })
        .chain(purchases.iter().flat_map(unsupported_funding_for))
        .collect();
    unsupported.sort_by(|l, r| {
        collate::compare(&l.effective_at, &r.effective_at)
            .then_with(|| collate::compare(&l.currency, &r.currency))
            .then_with(|| collate::compare(&l.adjustment_reference, &r.adjustment_reference))
    });
    let mut adjustments = Vec::new();
    for row in &evidence.funding_rows {
        if row.adjustment_type == "purchase_funding" {
            continue;
        }
        let kind = adjustment_type(&row.adjustment_type)
            .ok_or_else(|| format!("Funding {} has an unknown type.", row.adjustment_reference))?;
        adjustments.push(FundingAdjustment {
            adjustment_reference: row.adjustment_reference.clone(),
            currency: row.currency.clone(),
            adjustment_type: kind,
            amount_cents: row.amount_cents,
            effective_at: row.effective_at.clone(),
            provenance: provenance(&row.provenance),
            source_identity: row.source_identity.clone(),
        });
    }
    Ok(Input {
        seller_key: seller.to_owned(),
        as_of: as_of.to_owned(),
        sales: proceeds
            .sales
            .iter()
            .map(|s| SaleProceeds {
                order_number: s.order_number.clone(),
                sold_at: s.sold_at.clone(),
                currency: s.currency.clone(),
                amount_cents: s.amount_cents,
                provenance: provenance(s.provenance),
                source_identity: s.source_identity.clone(),
                source_identities: Some(s.source_identities.clone()),
            })
            .collect(),
        purchases,
        unsupported_purchase_funding: unsupported,
        funding_adjustments: adjustments,
        unknown_proceeds_order_count: proceeds.unknown_proceeds_order_count as i64,
        unknown_proceeds_sold_at: Some(
            proceeds
                .unknown_proceeds_sold_at
                .iter()
                .cloned()
                .map(Some)
                .collect(),
        ),
        unknown_cost_receipt_count: evidence.unknown_cost_receipts.len() as i64,
        unknown_cost_occurred_at: Some(
            evidence
                .unknown_cost_receipts
                .iter()
                .map(|r| r.occurred_at.map(iso))
                .collect(),
        ),
        unknown_cost_receipts: Some(
            evidence
                .unknown_cost_receipts
                .iter()
                .map(|r| UnknownCost {
                    receipt_id: r.receipt_id.into(),
                    product_line_id: r.product_line_id.into(),
                    occurred_at: r.occurred_at.map(iso),
                })
                .collect(),
        ),
        order_coverage: Some(evidence.order_coverage.clone()),
        source_evidence_identities,
    })
}

/// The report from one snapshot of the evidence, with the funding it could not support listed
/// as excluded.
pub async fn rebuild_report(
    conn: &mut PgConnection,
    seller: &str,
    as_of: &str,
) -> Result<Report, String> {
    let proceeds = proceeds::load_in(conn, seller).await?;
    let evidence = find_source_evidence(conn, seller).await?;
    let input = build_input(seller, as_of, &proceeds, &evidence)?;
    let mut report = allocate(&input)?;
    for unsupported in &input.unsupported_purchase_funding {
        report.excluded.push(Excluded {
            reason: match unsupported.kind {
                UnsupportedKind::Orphan => {
                    "Purchase-funding evidence without a matching current purchase cost".into()
                }
                UnsupportedKind::AboveCurrentCost => format!(
                    "Purchase funding above current cost for {}",
                    unsupported.purchase_reference.as_deref().unwrap_or("null")
                ),
            },
            count: 1,
            amount_cents: Some(unsupported.amount_cents),
            currency: Some(unsupported.currency.clone()),
        });
    }
    Ok(report)
}

/// Saves the rebuild unless one from the same evidence is saved already, and makes it current.
/// The saved report is the one returned, as the Node app returns it.
async fn save(conn: &mut PgConnection, report: &Report) -> Result<Report, String> {
    let e = |e: sqlx::Error| e.to_string();
    let found: Option<(String, Json<Report>)> = sqlx::query_as(
        "SELECT id::text,report FROM inventory_reinvestment_rebuilds
         WHERE seller_key=$1 AND rule_version=$2 AND effective_as_of=$3::timestamptz AND source_fingerprint=$4",
    )
    .bind(&report.seller_key)
    .bind(&report.rule_version)
    .bind(&report.as_of)
    .bind(&report.source_fingerprint)
    .fetch_optional(&mut *conn)
    .await
    .map_err(e)?;
    let (id, saved) = match found {
        Some(found) => found,
        None => {
            let inserted: (String, Json<Report>) = sqlx::query_as(
                "INSERT INTO inventory_reinvestment_rebuilds
                 (seller_key,rule_version,effective_as_of,source_fingerprint,report)
                 VALUES ($1,$2,$3::timestamptz,$4,$5) RETURNING id::text,report",
            )
            .bind(&report.seller_key)
            .bind(&report.rule_version)
            .bind(&report.as_of)
            .bind(&report.source_fingerprint)
            .bind(Json(report))
            .fetch_one(&mut *conn)
            .await
            .map_err(e)?;
            if !report.samples.is_empty() {
                sqlx::query(
                    r#"INSERT INTO inventory_reinvestment_allocations
                      (rebuild_id,sample_key,seller_key,currency,order_number,purchase_reference,receipt_id,amount_cents,sold_at,
                       funding_at,published_at,allocation_state,timing_basis,proceeds_provenance,cost_provenance,funding_provenance,
                       funding_adjustment_reference,explanation,source_identities)
                      SELECT $1::bigint,x."sampleKey",$2,x.currency,x."orderNumber",x."purchaseReference",x."receiptId",x."amountCents",
                        x."soldAt",x."fundingAt",x."publishedAt",x.state,x."timingBasis",x."proceedsProvenance",x."costProvenance",
                        x."fundingProvenance",x."fundingAdjustmentReference",x.explanation,x."sourceIdentities"
                      FROM jsonb_to_recordset($3::jsonb) AS x(
                        "sampleKey" text,currency text,"orderNumber" text,"purchaseReference" text,"receiptId" integer,
                        "amountCents" bigint,"soldAt" timestamptz,"fundingAt" timestamptz,"publishedAt" timestamptz,state text,
                        "timingBasis" text,"proceedsProvenance" text,"costProvenance" text,"fundingProvenance" text,
                        "fundingAdjustmentReference" text,explanation text,"sourceIdentities" jsonb)"#,
                )
                .bind(&inserted.0)
                .bind(&report.seller_key)
                .bind(Json(&report.samples))
                .execute(&mut *conn)
                .await
                .map_err(e)?;
            }
            inserted
        }
    };
    sqlx::query(
        "INSERT INTO inventory_reinvestment_current_rebuilds (seller_key,rebuild_id) VALUES ($1,$2::bigint)
         ON CONFLICT (seller_key) DO UPDATE SET rebuild_id=EXCLUDED.rebuild_id,updated_at=NOW()
         WHERE inventory_reinvestment_current_rebuilds.rebuild_id<>EXCLUDED.rebuild_id",
    )
    .bind(&report.seller_key)
    .bind(&id)
    .execute(&mut *conn)
    .await
    .map_err(e)?;
    Ok(saved.0)
}

/// The start of the hour `now` falls in, the as-of a rebuild is keyed by.
pub fn hour_of(now: DateTime<Utc>) -> DateTime<Utc> {
    now.with_nanosecond(0)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_minute(0))
        .unwrap_or(now)
}

/// Rebuilds the seller's turnaround as of `as_of` from one snapshot of the evidence, one rebuild
/// at a time per seller (the same advisory lock the Node app takes), and makes it current.
pub async fn load(db: &Database, seller: &str, as_of: DateTime<Utc>) -> Result<Report, String> {
    let seller = seller.trim();
    let as_of = iso(as_of);
    if seller.is_empty() {
        return allocate(&Input {
            seller_key: String::new(),
            as_of,
            sales: Vec::new(),
            purchases: Vec::new(),
            unsupported_purchase_funding: Vec::new(),
            funding_adjustments: Vec::new(),
            unknown_proceeds_order_count: 0,
            unknown_proceeds_sold_at: None,
            unknown_cost_receipt_count: 0,
            unknown_cost_occurred_at: None,
            unknown_cost_receipts: None,
            order_coverage: None,
            source_evidence_identities: Vec::new(),
        });
    }
    let e = |e: sqlx::Error| e.to_string();
    let mut conn = db.0.acquire().await.map_err(e)?;
    let lock = format!("inventory-reinvestment:{seller}");
    sqlx::query("SELECT pg_advisory_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut *conn)
        .await
        .map_err(e)?;
    let result = async {
        let mut tx = conn.begin().await.map_err(e)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        let report = rebuild_report(&mut tx, seller, &as_of).await?;
        let saved = save(&mut tx, &report).await?;
        tx.commit().await.map_err(e)?;
        Ok(saved)
    }
    .await;
    let unlocked = sqlx::query("SELECT pg_advisory_unlock(hashtext($1))")
        .bind(&lock)
        .execute(&mut *conn)
        .await;
    if unlocked.is_err() {
        // A lock that cannot be released must not go back to the pool.
        conn.detach();
    }
    result
}

/// The saved current report for the seller, if any.
async fn current(db: &Database, seller: &str) -> Result<Option<Report>, String> {
    let row: Option<(Json<Report>,)> = sqlx::query_as(
        "SELECT rebuild.report FROM inventory_reinvestment_current_rebuilds current
         JOIN inventory_reinvestment_rebuilds rebuild ON rebuild.id=current.rebuild_id WHERE current.seller_key=$1",
    )
    .bind(seller.trim())
    .fetch_optional(&db.0)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(r,)| r.0))
}

/// The report rebuilt now, or the saved one with why it could not be rebuilt.
pub async fn load_with_recovery(db: &Database, seller: &str) -> (Option<Report>, Option<String>) {
    match load(db, seller, hour_of(Utc::now())).await {
        Ok(report) => (Some(report), None),
        Err(why) => {
            eprintln!("Reinvestment turnaround rebuild failed: {why}");
            match current(db, seller).await {
                Ok(Some(prior)) => {
                    let note = format!(
                        "Current evidence could not be rebuilt. Showing the saved report effective {}.",
                        prior.as_of
                    );
                    (Some(prior), Some(note))
                }
                _ => (
                    None,
                    Some("Reinvestment turnaround could not be rebuilt from complete current evidence.".into()),
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Counts = (i64, i64, i64, Option<i64>);

    async fn counts(db: &Database, seller: &str) -> Counts {
        sqlx::query_as(
            "SELECT (SELECT count(*) FROM inventory_reinvestment_rebuilds),
                    (SELECT coalesce(max(id),0)::bigint FROM inventory_reinvestment_rebuilds),
                    (SELECT count(*) FROM inventory_reinvestment_allocations),
                    (SELECT rebuild_id::bigint FROM inventory_reinvestment_current_rebuilds WHERE seller_key=$1)",
        )
        .bind(seller)
        .fetch_one(&db.0)
        .await
        .unwrap()
    }

    type CurrentRow = Option<(i64, DateTime<Utc>)>;

    async fn current_row(db: &Database, seller: &str) -> CurrentRow {
        sqlx::query_as(
            "SELECT rebuild_id::bigint,updated_at FROM inventory_reinvestment_current_rebuilds WHERE seller_key=$1",
        )
        .bind(seller)
        .fetch_optional(&db.0)
        .await
        .unwrap()
    }

    /// Puts the tables back as `before`: the current rebuild as it was, and the new rebuilds and
    /// their allocations gone, with the triggers that keep them immutable off only for that, in
    /// one transaction, and the id sequence where it was.
    async fn restore(db: &Database, seller: &str, before: &Counts, current: &CurrentRow) {
        let mut tx = db.0.begin().await.unwrap();
        let run = |sql: &'static str| sqlx::query(sql);
        match current {
            Some((id, at)) => {
                run("UPDATE inventory_reinvestment_current_rebuilds SET rebuild_id=$2,updated_at=$3 WHERE seller_key=$1")
                    .bind(seller)
                    .bind(id)
                    .bind(at)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            None => {
                run("DELETE FROM inventory_reinvestment_current_rebuilds WHERE seller_key=$1")
                    .bind(seller)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
        }
        for sql in [
            "ALTER TABLE inventory_reinvestment_allocations DISABLE TRIGGER inventory_reinvestment_allocations_are_immutable",
            "ALTER TABLE inventory_reinvestment_rebuilds DISABLE TRIGGER inventory_reinvestment_rebuilds_are_immutable",
        ] {
            run(sql).execute(&mut *tx).await.unwrap();
        }
        run("DELETE FROM inventory_reinvestment_allocations WHERE rebuild_id>$1")
            .bind(before.1)
            .execute(&mut *tx)
            .await
            .unwrap();
        run("DELETE FROM inventory_reinvestment_rebuilds WHERE id>$1")
            .bind(before.1)
            .execute(&mut *tx)
            .await
            .unwrap();
        for sql in [
            "ALTER TABLE inventory_reinvestment_allocations ENABLE TRIGGER inventory_reinvestment_allocations_are_immutable",
            "ALTER TABLE inventory_reinvestment_rebuilds ENABLE TRIGGER inventory_reinvestment_rebuilds_are_immutable",
        ] {
            run(sql).execute(&mut *tx).await.unwrap();
        }
        run("SELECT setval('inventory_reinvestment_rebuilds_id_seq', GREATEST($1, 1), $1 > 0)")
            .bind(before.1)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    /// A rebuild is saved once per hour and evidence, with its allocations, and made current; the
    /// saved report has the keys the Node app's saved reports have. Restores the tables after.
    #[tokio::test]
    #[ignore = "writes the dev database's rebuild tables, and restores them"]
    async fn a_rebuild_is_saved_once_and_made_current_in_the_node_apps_shape() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let (seller,): (String,) = sqlx::query_as(
            "SELECT settings_json#>>'{continuousPricing,sellerKey}' FROM inventory_publication_settings WHERE config_key='default'",
        )
        .fetch_one(&db.0)
        .await
        .unwrap();
        let before = counts(&db, &seller).await;
        let current_before = current_row(&db, &seller).await;
        let (db_, seller_) = (db.clone(), seller.clone());
        // Spawned, so a failed assertion still reaches the cleanup below.
        let outcome = tokio::spawn(async move {
            let (db, seller) = (db_, seller_);
            let as_of = hour_of(Utc::now());
            let first = load(&db, &seller, as_of).await.unwrap();
            let after_first = counts(&db, &seller).await;
            let (id,): (i64,) = sqlx::query_as(
                "SELECT id::bigint FROM inventory_reinvestment_rebuilds WHERE seller_key=$1 AND effective_as_of=$2::timestamptz AND source_fingerprint=$3",
            )
            .bind(&seller)
            .bind(&first.as_of)
            .bind(&first.source_fingerprint)
            .fetch_one(&db.0)
            .await
            .unwrap();
            assert_eq!(after_first.3, Some(id), "the rebuild is current");
            let (allocations,): (i64,) = sqlx::query_as(
                "SELECT count(*) FROM inventory_reinvestment_allocations WHERE rebuild_id=$1",
            )
            .bind(id)
            .fetch_one(&db.0)
            .await
            .unwrap();
            assert_eq!(allocations as usize, first.samples.len(), "one allocation per sample");
            let second = load(&db, &seller, as_of).await.unwrap();
            assert_eq!(counts(&db, &seller).await, after_first, "the same evidence saves nothing new");
            assert_eq!(second, first, "the saved report is returned");
            let keys = |id: i64| {
                let db = db.clone();
                async move {
                    let (keys,): (Vec<String>,) = sqlx::query_as(
                        "SELECT array_agg(k ORDER BY k) FROM inventory_reinvestment_rebuilds, jsonb_object_keys(report) k WHERE id=$1",
                    )
                    .bind(id)
                    .fetch_one(&db.0)
                    .await
                    .unwrap();
                    keys
                }
            };
            let node = before.3.expect("the Node app saved a current rebuild");
            assert_eq!(keys(id).await, keys(node).await, "the report keeps the Node app's keys");
            eprintln!(
                "rebuild {id}: {} samples, {} rebuilds and {} allocations after (from {} and {})",
                first.samples.len(),
                after_first.0,
                after_first.2,
                before.0,
                before.2
            );
        })
        .await;
        restore(&db, &seller, &before, &current_before).await;
        assert_eq!(
            counts(&db, &seller).await,
            before,
            "the tables are as they were"
        );
        assert_eq!(
            current_row(&db, &seller).await,
            current_before,
            "the current rebuild is as it was"
        );
        outcome.unwrap();
    }
}
