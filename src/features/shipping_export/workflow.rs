//! The shipping workflow in progress (`shipping_workflows`, migration 054): what cannot be worked
//! out again. Shipments are planned again from the orders under the current settings, and
//! outbound postage is read again from the Node app's record, so neither is kept; the React
//! screen's localStorage kept the same, and shipment edits, which it lost on a reload, are kept
//! here.
use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Json;

use super::{
    orders::Order,
    postage::{BatchLabel, Postage},
    ship::{Messaged, Tracked},
    shipments::Shipment,
};
use crate::{database::Database, features::shipping_configuration::LabelSize};

/// The one workflow there is: the shop ships one batch at a time.
const KEY: &str = "current";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workflow {
    /// The seller the orders were loaded for, whose buyers are told they shipped.
    pub seller_key: String,
    /// Where the orders came from: "Live seller orders: ..." or "Single TCGPlayer order: ...".
    pub source: String,
    pub warnings: Vec<String>,
    pub orders: Vec<Order>,
    /// Return labels bought, by shipment.
    pub returns: Postage,
    /// One PDF of each label size's labels.
    pub batch_labels: Vec<SizedLabel>,
    /// Shipments edited by hand, by reference: used in place of the planned one.
    pub edits: BTreeMap<String, Shipment>,
    /// The shipments packed, by reference.
    pub packed: Vec<String>,
    pub tracked: Vec<Tracked>,
    pub messaged: Vec<Messaged>,
    /// When the orders' intake history was last read.
    pub intake_read_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizedLabel {
    pub label_size: LabelSize,
    pub label: BatchLabel,
}

impl Workflow {
    /// A workflow for orders just loaded: nothing done yet.
    pub fn loaded(
        seller_key: String,
        source: String,
        warnings: Vec<String>,
        orders: Vec<Order>,
    ) -> Self {
        Workflow {
            seller_key,
            source,
            warnings,
            orders,
            ..Workflow::default()
        }
    }

    pub fn batch_label(&self, size: LabelSize) -> Option<&BatchLabel> {
        self.batch_labels
            .iter()
            .find(|l| l.label_size == size)
            .map(|l| &l.label)
    }

    pub fn set_batch_label(&mut self, size: LabelSize, label: BatchLabel) {
        self.batch_labels.retain(|l| l.label_size != size);
        self.batch_labels.push(SizedLabel {
            label_size: size,
            label,
        });
    }

    pub fn is_packed(&self, reference: &str) -> bool {
        self.packed.iter().any(|r| r == reference)
    }
}

/// The workflow and when it was last saved.
pub struct Saved {
    pub workflow: Workflow,
    pub saved_at: DateTime<Utc>,
}

/// The workflow in progress, if any. One this version cannot read is none, as the React screen
/// dropped one it could not restore rather than half restore it.
pub async fn current(db: &Database) -> sqlx::Result<Option<Saved>> {
    let row: Option<(serde_json::Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT workflow_json, saved_at FROM shipping_workflows WHERE workflow_key = $1",
    )
    .bind(KEY)
    .fetch_optional(&db.0)
    .await?;
    Ok(row.and_then(|(json, saved_at)| {
        serde_json::from_value(json)
            .ok()
            .map(|workflow| Saved { workflow, saved_at })
    }))
}

/// Starts over with `workflow`; one without orders clears it.
pub async fn replace(db: &Database, workflow: &Workflow) -> sqlx::Result<()> {
    if workflow.orders.is_empty() {
        sqlx::query("DELETE FROM shipping_workflows WHERE workflow_key = $1")
            .bind(KEY)
            .execute(&db.0)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO shipping_workflows (workflow_key, workflow_json, saved_at) VALUES ($1, $2, NOW())
         ON CONFLICT (workflow_key) DO UPDATE SET workflow_json = EXCLUDED.workflow_json, saved_at = NOW()",
    )
    .bind(KEY)
    .bind(Json(workflow))
    .execute(&db.0)
    .await?;
    Ok(())
}

/// Changes the workflow in progress, holding it while `change` runs so two changes at once (two
/// tabs) both land. None when there is no workflow to change.
pub async fn change<R>(
    db: &Database,
    change: impl FnOnce(&mut Workflow) -> R,
) -> sqlx::Result<Option<R>> {
    let mut tx = db.0.begin().await?;
    let row: Option<(serde_json::Value,)> = sqlx::query_as(
        "SELECT workflow_json FROM shipping_workflows WHERE workflow_key = $1 FOR UPDATE",
    )
    .bind(KEY)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(mut workflow) = row.and_then(|(json,)| serde_json::from_value::<Workflow>(json).ok())
    else {
        return Ok(None);
    };
    let out = change(&mut workflow);
    sqlx::query("UPDATE shipping_workflows SET workflow_json = $2, saved_at = NOW() WHERE workflow_key = $1")
        .bind(KEY)
        .bind(Json(&workflow))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(out))
}
