//! The Pack step: the shipment being packed, with its cards matched from the pull sheet, or
//! every shipment in a list; and marking one packed, which moves to the next not packed.
use corten::{ClientZone, prelude::*};
use serde::Deserialize;

use super::{
    pack::{self, PackView},
    page::{Shown, hours_ahead},
    sheet,
    steps::Step,
    url::{self, ShippingWorkflow},
    value,
    views::{PackCard, PackRow, PackedOrder, Packing},
    workflow,
};
use crate::{
    database::Database, features::pull_sheet, layout::Tone, legacy::Legacy, zone::Visitor,
};

/// The Pack step for the shipment `chosen` (the first not packed when none, or one not in the
/// batch), in `view`. The pull sheet is read only for the card view.
pub async fn packing<'a>(
    db: &Database,
    legacy: &Legacy,
    shown: &'a Shown,
    visitor: Visitor,
    chosen: Option<&str>,
    view: PackView,
) -> Packing<'a> {
    let batch = &shown.batch;
    let packed = |reference: &str| shown.workflow().is_some_and(|w| w.is_packed(reference));
    let rows: Vec<PackRow> = batch
        .shipments
        .iter()
        .map(|planned| {
            let orders: Vec<_> = batch.orders_of(planned).collect();
            PackRow {
                planned,
                items: orders.iter().map(|o| o.item_count).sum(),
                value: value::of_orders(orders.iter().copied()),
                orders,
                postage: shown.outbound(planned.reference()),
                packed: packed(planned.reference()),
            }
        })
        .collect();
    let index = chosen
        .and_then(|r| rows.iter().position(|row| row.planned.reference() == r))
        .or_else(|| rows.iter().position(|row| !row.packed))
        .unwrap_or(0);
    let card = match (rows.get(index), view) {
        (None, _) => None,
        (Some(_), PackView::List) => Some(PackCard {
            index,
            notice: None,
            orders: Vec::new(),
        }),
        (Some(row), PackView::Card) => {
            Some(card(db, legacy, row, index, visitor, &batch.order_numbers()).await)
        }
    };
    Packing { view, rows, card }
}

/// The shipment's orders with their cards: pictures when the pull sheet matches them, else a
/// list, saying why.
async fn card<'a>(
    db: &Database,
    legacy: &Legacy,
    row: &PackRow<'a>,
    index: usize,
    visitor: Visitor,
    numbers: &[String],
) -> PackCard<'a> {
    let has_lines = row.orders.iter().any(|o| !o.lines().is_empty());
    let read = if has_lines {
        match sheet::export(legacy, numbers, hours_ahead(visitor)).await {
            Ok(text) => pull_sheet::read(db, &text).await.map(|(items, _)| items),
            Err(why) => Err(why),
        }
    } else {
        Ok(Vec::new())
    };
    let (matched, notice) = match &read {
        _ if !has_lines => (
            None,
            Some((
                Tone::Info,
                "Line item details unavailable - refer to the packing slip PDF.".to_owned(),
            )),
        ),
        Err(why) => (
            None,
            Some((
                Tone::Warning,
                format!(
                    "Visual pull sheet unavailable: {why} Showing the shipment item list instead."
                ),
            )),
        ),
        Ok(items) => {
            let matched = pack::matched(items, &row.orders);
            let notice = matched.fallback.map(|why| {
                (
                    Tone::Info,
                    format!("{why} Showing the shipment item list instead."),
                )
            });
            (Some(matched), notice)
        }
    };
    let pictures = matched.as_ref().is_some_and(pack::Matched::as_pictures);
    let orders = row
        .orders
        .iter()
        .map(|&order| {
            let of_order = matched
                .as_ref()
                .map_or_else(Vec::new, |m| pack::of_order(&m.items, &order.number));
            PackedOrder {
                order,
                value: value::of_orders([order]),
                listed: if pictures {
                    Vec::new()
                } else {
                    pack::listed(order, &of_order)
                },
                pictures: if pictures {
                    of_order
                        .into_iter()
                        .map(|item| {
                            let value = item.sku_id.map(|sku| value::of_card([order], sku));
                            (item, value)
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            }
        })
        .collect();
    PackCard {
        index,
        notice,
        orders,
    }
}

#[derive(Deserialize, Fields)]
pub struct PackedInput {
    /// What the shipment is to be: the form says, so sending it twice does the same.
    #[serde(default)]
    pub packed: bool,
    #[serde(default)]
    pub view: PackView,
}

/// The shipment marked packed, or not. Packed, the step moves to the next shipment not packed
/// after it, else the first before it, as the React screen did; unmarked, it stays.
pub async fn set_packed(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ShipmentPacked>,
    Form(input): Form<PackedInput>,
) -> HtmlResult {
    let reference = at.reference;
    let shown = Shown::read(&db, &legacy).await?;
    let order: Vec<String> = shown
        .batch
        .shipments
        .iter()
        .map(|p| p.reference().to_owned())
        .collect();
    if !order.contains(&reference) {
        let why = format!("Shipment {reference} is not in this batch.");
        let visitor = Visitor::of(zone.as_ref());
        return super::page::refused(&req, &db, &legacy, visitor, Step::Pack, &why).await;
    }
    let packed = input.packed;
    let marked = reference.clone();
    let now = workflow::change(&db, move |w| {
        w.packed.retain(|r| *r != marked);
        if packed {
            w.packed.push(marked);
        }
        w.packed.clone()
    })
    .await?
    .unwrap_or_default();
    let next = if packed {
        next_to_pack(&order, &reference, &now)
    } else {
        None
    };
    req.redirect(&ShippingWorkflow {
        shipment: Some(next.unwrap_or(reference)),
        view: (input.view == PackView::List).then_some(PackView::List),
        ..ShippingWorkflow::at(Step::Pack)
    })
}

/// The shipment to pack after `reference`: the next not packed after it, else the first not
/// packed before it.
fn next_to_pack(order: &[String], reference: &str, packed: &[String]) -> Option<String> {
    let at = order.iter().position(|r| r == reference)?;
    let open = |r: &&String| !packed.contains(r);
    order[at + 1..]
        .iter()
        .find(open)
        .or_else(|| order[..at].iter().find(open))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packing_moves_to_the_next_shipment_not_packed() {
        let order: Vec<String> = ["A", "B", "C", "D"].map(String::from).to_vec();
        let packed = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            next_to_pack(&order, "B", &packed(&["B", "C"])),
            Some("D".into())
        );
        assert_eq!(
            next_to_pack(&order, "D", &packed(&["B", "C", "D"])),
            Some("A".into())
        );
        assert_eq!(
            next_to_pack(&order, "A", &packed(&["A", "B", "C", "D"])),
            None
        );
    }
}
