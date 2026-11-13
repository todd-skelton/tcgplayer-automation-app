//! The Ship step's post: the orders with production postage marked shipped on TCGplayer with
//! their tracking, then their buyers told (Mark Shipped & Notify Buyers). Each part's results are
//! kept as they come back, so a failure part way keeps what went
//! and shipping again reaches only what did not.
use std::collections::HashSet;

use corten::{Refusal, prelude::*};

use super::{
    easypost::EasyPost,
    one_at_a_time::OneAtATime,
    page::{Shown, refused},
    ship::{self, Message},
    steps::Step,
    url::ShippingWorkflow,
    workflow,
};
use crate::{database::Database, tcgplayer::TcgPlayer};

/// Buyers hear once: a second click, tab, computer or app instance waits for the first to finish.
static SHIPPING: OneAtATime = OneAtATime::new("shipping export ship");

const SHIPPING_NOW: &str = "Orders are already being marked shipped. Try again when that finishes.";
const NO_SELLER: &str =
    "Set the seller key on Load Orders before shipping. Buyers can only be notified with it.";
const NOTHING_PENDING: &str = "No order is waiting to be marked shipped.";

pub async fn mark_shipped(req: Req, State(db): State<Database>) -> HtmlResult {
    let refuse = |refusal: Refusal, why: String| {
        let (req, db) = (&req, &db);
        async move { refused(req, db, Step::Ship, refusal, &why).await }
    };
    let Some(_shipping) = SHIPPING.start(&db).await? else {
        return refuse(Refusal::Conflict, SHIPPING_NOW.into()).await;
    };
    let shown = Shown::read(&db).await?;
    if !shown.has_seller() {
        return refuse(Refusal::Conflict, NO_SELLER.into()).await;
    }
    if let Some(why) = shown.postage_failure() {
        return refuse(
            Refusal::Upstream,
            format!("Failed to load saved postage: {why}"),
        )
        .await;
    }
    let pending = shown.pending();
    if pending.orders().is_empty() {
        return refuse(Refusal::Conflict, NOTHING_PENDING.into()).await;
    }
    // An order whose tracking did not apply is not messaged: its buyer would get no tracking.
    let mut untracked: HashSet<String> = pending
        .tracking
        .iter()
        .map(|t| t.order_number.clone())
        .collect();
    if !pending.tracking.is_empty() {
        let results = match ship::apply_tracking(
            &ship::TcgPlayerTracking(TcgPlayer::new(db.clone())),
            &pending.tracking,
        )
        .await
        {
            Ok(results) => results,
            Err(why) => {
                return refuse(
                    Refusal::Upstream,
                    format!("Failed to apply tracking to TCGPlayer orders: {why}"),
                )
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
        let results = match ship::send_messages(
            &ship::TcgPlayerMessages(TcgPlayer::new(db.clone())),
            &EasyPost::default(),
            &messages,
        )
        .await
        {
            Ok(results) => results,
            Err(why) => {
                return refuse(
                    Refusal::Upstream,
                    format!("Failed to send shipped messages to TCGPlayer: {why}"),
                )
                .await;
            }
        };
        workflow::change(&db, |w| ship::merge(&mut w.messaged, results)).await?;
    }
    req.redirect(&ShippingWorkflow::at(Step::Ship))
}
