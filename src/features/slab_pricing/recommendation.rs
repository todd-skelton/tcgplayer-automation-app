//! The owned slab's recommendation: a market range from the saved sold evidence, and an item ask
//! from the seller's costs. Calculating one stays the Node app's (`/api/slab-recommendations`,
//! from saved evidence only, never a provider); the operator's reviewed ask on the latest is saved
//! here (`overrideSlabPrice`), and the latest is read with the research.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::features::inventory_economics::ledger::fingerprint::js_float;

/// The valuation policy the React screen sent, with the comparable price basis chosen. The
/// same values as `DEFAULT_SLAB_POLICY` in `app/features/ebay-slab-pricing/valuation/slabValuation.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy<'a> {
    currency: &'static str,
    basis: &'a str,
    minimum_comps: u32,
    minimum_effective_count: f64,
    half_life_days: u32,
    maximum_age_days: u32,
    rounding_increment: f64,
    review_change_fraction: f64,
    review_spread_ratio: f64,
}

impl Policy<'_> {
    pub fn with_basis(basis: &str) -> Policy<'_> {
        Policy {
            currency: "USD",
            basis,
            minimum_comps: 3,
            minimum_effective_count: 2.5,
            half_life_days: 90,
            maximum_age_days: 365,
            rounding_increment: 0.01,
            review_change_fraction: 0.25,
            review_spread_ratio: 4.0,
        }
    }
}

/// A stored recommendation (`getSlabRecommendation`) as JSON: `current` while its identity,
/// decisions and evidence are as it was calculated from, and the ask reviewed on it.
macro_rules! stored {
    ($which:literal) => {
        concat!(
            r#"SELECT jsonb_build_object('id', r.id, 'calculation', r.calculation,
    'current', (i.revision = r.identity_revision AND i.valuation_group_key = r.valuation_group_key AND i.status = 'confirmed'
    AND r.calculation->'decisions' = COALESCE((SELECT jsonb_agg(d.decision ORDER BY d.revision_id,d.event_key) FROM slab_comp_decisions d
      WHERE d.valuation_group_key=r.valuation_group_key AND d.revision_id IN (SELECT revision_id FROM slab_recommendation_evidence WHERE recommendation_id=r.id)), '[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM slab_recommendation_evidence e JOIN slab_evidence_revisions v ON v.id=e.revision_id
      JOIN slab_evidence_refreshes j ON j.key=v.key WHERE e.recommendation_id=r.id AND (j.latest_revision IS DISTINCT FROM v.id OR j.expires_at <= clock_timestamp() OR j.expires_at IS NULL OR j.state='failed'))),
    'override', CASE WHEN o.recommendation_id IS NULL THEN NULL ELSE jsonb_build_object('itemPrice',o.item_price,'currency',o.currency,'note',o.note,'reviewedAt',o.reviewed_at) END)
    FROM slab_recommendations r JOIN slab_identities i ON i.id=r.slab_id LEFT JOIN slab_price_overrides o ON o.recommendation_id=r.id
    "#,
            $which
        )
    };
}

/// The slab's latest recommendation.
pub(super) const LATEST: &str = stored!(
    "WHERE r.id = (SELECT id FROM slab_recommendations WHERE slab_id=$1::uuid ORDER BY created_at DESC, id DESC LIMIT 1)"
);

/// The recommendation `id`.
pub(super) const BY_ID: &str = stored!("WHERE r.id = $1::uuid");

/// The comparable price basis, as the select and the policy write it.
pub const BASES: [(&str, &str); 2] = [
    ("item-plus-shipping", "Item + shipping"),
    ("item-only", "Item only"),
];

/// A saved recommendation, whether it still matches its identity, decisions and evidence
/// (`current`), and the ask the operator reviewed, if any.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub calculation: Calculation,
    pub current: bool,
    pub r#override: Option<Override>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Override {
    pub item_price: f64,
    pub currency: String,
    pub note: String,
    /// When it was reviewed: a price-change preview of it names this time, so a newer review
    /// refuses the preview.
    pub reviewed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Calculation {
    pub identity: Revisioned,
    pub policy: Basis,
    pub seller: Seller,
    pub market: Market,
    pub ask: Ask,
    pub dispositions: Vec<Disposition>,
    pub evidence: Vec<Used>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Revisioned {
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Basis {
    pub basis: String,
}

/// The seller's costs the ask was proposed from. Missing ones were unknown.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seller {
    pub current_ask: Option<f64>,
    pub shipping_charged: Option<f64>,
    pub shipping_cost: Option<f64>,
    pub acquisition_cost: Option<f64>,
    pub minimum_ask: Option<f64>,
    pub minimum_profit: Option<f64>,
    pub fees: Option<Fees>,
}

impl Seller {
    /// `minimumSellerAsk`: the lowest item ask that keeps the seller's minimum ask and, when one
    /// is set, the minimum profit after acquisition, shipping and fees; `None` when that profit
    /// cannot be worked out from what is known. Not a number when the costs make no sense, as
    /// Node's `Math.max` gave.
    pub fn lowest_ask(&self) -> Option<f64> {
        let floor = self.minimum_ask.unwrap_or(0.0);
        let Some(profit) = self.minimum_profit else {
            return Some(floor);
        };
        let (Some(acquisition), Some(shipping_cost), Some(shipping_charged), Some(fees)) = (
            self.acquisition_cost,
            self.shipping_cost,
            self.shipping_charged,
            &self.fees,
        ) else {
            return None;
        };
        let fee_on_shipping = if fees.basis == "item-plus-shipping" {
            shipping_charged * fees.rate
        } else {
            0.0
        };
        let needed = (acquisition + shipping_cost + profit + fees.fixed - shipping_charged
            + fee_on_shipping)
            / (1.0 - fees.rate);
        Some(if needed.is_nan() {
            needed
        } else {
            floor.max(needed)
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Fees {
    /// A fraction: 0.1325 for 13.25%.
    pub rate: f64,
    pub fixed: f64,
    pub basis: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub basis: String,
    pub as_of: String,
    pub range: Option<Span>,
    pub observed_span: Option<Span>,
    pub count: u32,
    pub effective_count: f64,
    pub comps: Vec<Comp>,
    pub excluded: Vec<Excluded>,
    pub flags: Vec<Flag>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Span {
    pub low: f64,
    pub high: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Comp {
    pub date: String,
    pub amount: f64,
    pub currency: String,
    pub weight: f64,
    pub references: Vec<Reference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub provider: String,
    pub provider_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Excluded {
    pub key: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Flag {
    pub code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub proposed_item_ask: Option<f64>,
    pub estimated_proceeds: Option<f64>,
    pub estimated_profit: Option<f64>,
    pub flags: Vec<Flag>,
    pub requires_review: bool,
}

/// A sold event the calculation left out or could not be sure of.
#[derive(Clone, Debug, Deserialize)]
pub struct Disposition {
    /// `needs-review` or `rejected`.
    pub status: String,
    pub reasons: Vec<String>,
    pub references: Vec<Reference>,
}

/// An evidence revision the calculation read.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Used {
    pub revision_id: String,
}

impl Recommendation {
    /// It needs calculating again: its identity, comp decisions or evidence changed (the Node
    /// app's `current`), or newer evidence is saved than it read (`latest`, when the owned
    /// grade is shown and could be calculated).
    pub fn stale(&self, latest: Option<&BTreeSet<String>>) -> bool {
        let read: BTreeSet<&str> = self
            .calculation
            .evidence
            .iter()
            .map(|e| e.revision_id.as_str())
            .collect();
        !self.current
            || latest
                .is_some_and(|latest| !latest.iter().map(String::as_str).eq(read.iter().copied()))
    }

    /// The codes of the market's and the ask's flags, each once, in order.
    pub fn flags(&self) -> Vec<&str> {
        let mut seen = BTreeSet::new();
        let c = &self.calculation;
        c.market
            .flags
            .iter()
            .chain(&c.ask.flags)
            .map(|f| f.code.as_str())
            .filter(|code| seen.insert(*code))
            .collect()
    }

    /// How many events the calculation was unsure of, and how many it left out.
    pub fn uncertain_and_rejected(&self) -> (usize, usize) {
        let d = &self.calculation.dispositions;
        let count = |status| d.iter().filter(|x| x.status == status).count();
        (count("needs-review"), count("rejected"))
    }
}

/// `USD 12.30` as the React screen wrote an amount, or "Unknown".
pub fn amount(value: Option<f64>) -> String {
    value.map_or_else(|| "Unknown".into(), |v| format!("USD {v:.2}"))
}

/// The operator's reviewed ask for a recommendation, and why.
pub struct ReviewedAsk<'a> {
    pub recommendation_id: &'a str,
    pub item_price: f64,
    pub currency: &'a str,
    pub note: &'a str,
}

/// `overrideSlabPrice`: the reviewed ask saved on the slab's latest recommendation, while its
/// identity is still the confirmed one it was calculated for and its currency is the ask's.
pub async fn review_ask(conn: &mut sqlx::PgConnection, o: &ReviewedAsk<'_>) -> Result<(), String> {
    use sqlx::Connection;
    let uuid = o.recommendation_id.len() == 36
        && o.recommendation_id
            .bytes()
            .enumerate()
            .all(|(i, b)| match i {
                8 | 13 | 18 | 23 => b == b'-',
                _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
            });
    let note = o.note.trim();
    if !uuid
        || !o.item_price.is_finite()
        || o.item_price <= 0.0
        || o.item_price >= 1e9
        || o.currency.len() != 3
        || !o.currency.bytes().all(|b| b.is_ascii_uppercase())
        || note.is_empty()
        || o.note.encode_utf16().count() > 1000
    {
        return Err("Provide an explicit item price, currency and review reason.".to_owned());
    }
    let failed = |error: sqlx::Error| {
        eprintln!("slab reviewed ask: {error}");
        "Unable to calculate a slab recommendation.".to_owned()
    };
    let mut tx = conn.begin().await.map_err(failed)?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    sqlx::query(
        "SELECT i.id FROM slab_identities i JOIN slab_recommendations r ON r.slab_id=i.id WHERE r.id=$1::uuid FOR UPDATE OF i",
    )
    .bind(o.recommendation_id)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    let saved = sqlx::query(
        "INSERT INTO slab_price_overrides(recommendation_id,item_price,currency,note)
         SELECT r.id,$2::numeric,$3,$4 FROM slab_recommendations r JOIN slab_identities i ON i.id=r.slab_id
         WHERE r.id=$1::uuid AND i.revision=r.identity_revision AND i.status='confirmed' AND i.valuation_group_key=r.valuation_group_key
           AND r.calculation->'policy'->>'currency'=$3
           AND r.id=(SELECT latest.id FROM slab_recommendations latest WHERE latest.slab_id=r.slab_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
         ON CONFLICT(recommendation_id) DO UPDATE SET item_price=EXCLUDED.item_price,currency=EXCLUDED.currency,note=EXCLUDED.note,reviewed_at=clock_timestamp()",
    )
    .bind(o.recommendation_id)
    // The amount as JavaScript writes it, which is what Node's driver sends.
    .bind(js_float(o.item_price))
    .bind(o.currency)
    .bind(note)
    .execute(&mut *tx)
    .await
    .map_err(failed)?
    .rows_affected();
    tx.commit().await.map_err(failed)?;
    if saved == 0 {
        return Err(
            "The recommendation changed or uses another currency. Recalculate before overriding."
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `/api/slab-recommendations` override recorded over
    /// `.port-logs/slab-override-cases.json` (`slab-override-node.ts`), in order, on the slabs and
    /// recommendations `slab-workspace-seed.sql` saves, inside a transaction rolled back: each must
    /// answer as Node answered (its refusals were 400s with the message here) and leave the reviewed
    /// asks as Node did.
    #[tokio::test]
    #[ignore = "reads the dev database and .port-logs; writes only in a transaction that is rolled back"]
    async fn reviews_asks_as_node_does() {
        use serde_json::Value;
        use sqlx::Connection;
        crate::config::load_env();
        let db = crate::database::Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read("slab-override-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("slab-override.node.json")).unwrap();
        let capture = read("slab-override-capture.sql");
        assert_eq!(cases.len(), node.len());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::raw_sql(&read("slab-workspace-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, node) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let b = &case["body"];
            let o = ReviewedAsk {
                recommendation_id: b["recommendationId"].as_str().unwrap(),
                item_price: b["itemPrice"].as_f64().unwrap(),
                currency: b["currency"].as_str().unwrap(),
                note: b["note"].as_str().unwrap(),
            };
            let got = review_ask(&mut tx, &o).await;
            assert_eq!(got.err().as_deref(), node["error"].as_str(), "{name}");
            let saved: Value = sqlx::query_scalar(&capture)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(saved, node["saved"], "{name}: saved");
        }
        tx.rollback().await.unwrap();
    }

    fn saved(current: bool, read: &[&str]) -> Recommendation {
        serde_json::from_value(serde_json::json!({
            "id": "r", "current": current, "override": null,
            "calculation": {
                "identity": { "revision": 1 }, "policy": { "basis": "item-only" }, "seller": {},
                "market": { "basis": "item-only", "asOf": "2026-10-30T00:00:00Z", "range": null,
                    "observedSpan": null, "count": 0, "effectiveCount": 0, "comps": [], "excluded": [],
                    "flags": [{ "code": "insufficient-comps" }] },
                "ask": { "proposedItemAsk": null, "estimatedProceeds": null, "estimatedProfit": null,
                    "flags": [{ "code": "insufficient-comps" }, { "code": "no-floor" }], "requiresReview": true },
                "dispositions": [],
                "evidence": read.iter().map(|id| serde_json::json!({ "revisionId": id })).collect::<Vec<_>>()
            }
        }))
        .unwrap()
    }

    #[test]
    fn a_recommendation_is_stale_when_newer_evidence_is_saved() {
        let latest: BTreeSet<String> = ["a".into(), "b".into()].into();
        assert!(!saved(true, &["b", "a"]).stale(Some(&latest)));
        assert!(saved(true, &["a"]).stale(Some(&latest)));
        assert!(!saved(true, &["a"]).stale(None));
        assert!(saved(false, &["a", "b"]).stale(Some(&latest)));
    }

    #[test]
    fn flags_are_listed_once() {
        assert_eq!(saved(true, &[]).flags(), ["insufficient-comps", "no-floor"]);
        assert_eq!(amount(Some(12.3)), "USD 12.30");
        assert_eq!(amount(None), "Unknown");
    }
}
