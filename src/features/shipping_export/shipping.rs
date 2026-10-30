//! The Ship step's post: the orders with production postage marked shipped on TCGplayer with
//! their tracking, then their buyers told, as the React screen's Mark Shipped & Notify Buyers
//! did. Each part's results are kept as they come back, so a failure part way keeps what went
//! and shipping again reaches only what did not.
use std::collections::HashSet;

use corten::{ClientZone, prelude::*};

use super::{
    one_at_a_time::OneAtATime,
    page::{Shown, refused},
    ship::{self, Message},
    steps::Step,
    url::ShippingWorkflow,
    workflow,
};
use crate::{database::Database, legacy::Legacy, zone::Visitor};

/// Buyers hear once: a second click, tab or computer waits for the first to finish.
static SHIPPING: OneAtATime = OneAtATime::new();

const SHIPPING_NOW: &str = "Orders are already being marked shipped. Try again when that finishes.";
const NO_SELLER: &str =
    "Set the seller key on Load Orders before shipping. Buyers can only be notified with it.";
const NOTHING_PENDING: &str = "No order is waiting to be marked shipped.";

pub async fn mark_shipped(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let refuse = |why: String| {
        let (req, db, legacy) = (&req, &db, &legacy);
        async move { refused(req, db, legacy, visitor, Step::Ship, &why).await }
    };
    let Some(_shipping) = SHIPPING.start() else {
        return refuse(SHIPPING_NOW.into()).await;
    };
    let shown = Shown::read(&db, &legacy).await?;
    if !shown.has_seller() {
        return refuse(NO_SELLER.into()).await;
    }
    if let Some(why) = shown.postage_failure() {
        return refuse(format!("Failed to load saved postage: {why}")).await;
    }
    let pending = shown.pending();
    if pending.orders().is_empty() {
        return refuse(NOTHING_PENDING.into()).await;
    }
    // An order whose tracking did not apply is not messaged: its buyer would get no tracking.
    let mut untracked: HashSet<String> = pending
        .tracking
        .iter()
        .map(|t| t.order_number.clone())
        .collect();
    if !pending.tracking.is_empty() {
        let results = match ship::apply_tracking(&legacy, &pending.tracking).await {
            Ok(results) => results,
            Err(why) => {
                return refuse(format!(
                    "Failed to apply tracking to TCGPlayer orders: {why}"
                ))
                .await;
            }
        };
        for applied in results.iter().filter(|r| r.status == "applied") {
            untracked.remove(&applied.order_number);
        }
        workflow::change(&db, |w| ship::merge(&mut w.tracked, results)).await?;
    }
    let messages: Vec<Message> = pending
        .messages
        .into_iter()
        .filter(|m| !untracked.contains(&m.order_number))
        .collect();
    if !messages.is_empty() {
        let results = match ship::send_messages(&legacy, &messages).await {
            Ok(results) => results,
            Err(why) => {
                return refuse(format!(
                    "Failed to send shipped messages to TCGPlayer: {why}"
                ))
                .await;
            }
        };
        workflow::change(&db, |w| ship::merge(&mut w.messaged, results)).await?;
    }
    req.redirect(&ShippingWorkflow::at(Step::Ship))
}
