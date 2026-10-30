//! What the Pack step shows for a shipment: the batch's pull sheet matched to its orders, so each
//! card can be checked against the picture, or a list of what to pack when it cannot be matched
//! (ported from `services/packPullSheet.ts` and `PackStep.tsx`).
use std::collections::BTreeMap;

use serde::Deserialize;

use super::{
    orders::{Line, Order},
    value::{self, SaleValue},
};
use crate::features::pull_sheet::Item;

/// How the Pack step shows the shipments: one at a time with its cards, or all in a list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum PackView {
    #[default]
    Card,
    List,
}

/// The batch's pull sheet as it matches one shipment.
#[derive(Debug)]
pub struct Matched {
    /// The cards for the shipment, each with the quantity its orders took. Shown as pictures only
    /// when nothing was missed.
    pub items: Vec<Item>,
    /// Why the pictures cannot be trusted for this shipment, when they cannot.
    pub fallback: Option<&'static str>,
}

impl Matched {
    pub fn as_pictures(&self) -> bool {
        self.fallback.is_none() && !self.items.is_empty()
    }
}

/// A pull sheet line's "Order Quantity" (`ORDER-1:2|ORDER-2:1`): each order and how many it
/// took, or none when any part of it cannot be read.
fn order_quantities(text: &str) -> Option<Vec<(&str, u32)>> {
    let entries: Vec<&str> = text
        .split('|')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries
        .into_iter()
        .map(|entry| {
            let (order, quantity) = entry.rsplit_once(':')?;
            let (order, quantity) = (order.trim(), quantity.trim().parse::<u32>().ok()?);
            (!order.is_empty() && quantity > 0).then_some((order, quantity))
        })
        .collect()
}

/// The item with the quantity these orders took of it, if they took any; none when its order
/// quantities cannot be read.
fn taken_by(item: &Item, orders: &[&str]) -> Option<Option<Item>> {
    let taken: u32 = order_quantities(&item.order_quantity)?
        .into_iter()
        .filter(|(order, _)| orders.contains(order))
        .map(|(_, quantity)| quantity)
        .sum();
    Some((taken > 0).then(|| Item {
        quantity: taken,
        ..item.clone()
    }))
}

/// The pull sheet's cards for a shipment's orders. The pictures stand only when the quantities
/// add up to the orders' lines and every line of the sheet could be read.
pub fn matched(items: &[Item], orders: &[&Order]) -> Matched {
    let expected: u32 = orders
        .iter()
        .flat_map(|o| o.lines())
        .map(|l| l.quantity)
        .sum();
    if orders.iter().all(|o| o.lines().is_empty()) {
        return Matched {
            items: Vec::new(),
            fallback: Some("Line item details unavailable for this shipment."),
        };
    }
    let numbers: Vec<&str> = orders.iter().map(|o| o.number.trim()).collect();
    let mut unreadable = false;
    let mut found = Vec::new();
    for item in items {
        match taken_by(item, &numbers) {
            None => unreadable = true,
            Some(Some(taken)) => found.push(taken),
            Some(None) => {}
        }
    }
    let matched: u32 = found.iter().map(|i| i.quantity).sum();
    let fallback = if unreadable {
        Some("Pull sheet order data was missing or malformed for this shipment.")
    } else if matched != expected {
        Some("Visual pull sheet matching was incomplete for this shipment.")
    } else {
        None
    };
    Matched {
        items: found,
        fallback,
    }
}

/// The cards of one order among a shipment's (`getPullSheetItemsForOrder`).
pub fn of_order(items: &[Item], number: &str) -> Vec<Item> {
    let number = number.trim();
    items
        .iter()
        .filter_map(|item| taken_by(item, &[number]).flatten())
        .collect()
}

/// A line of the list shown when the pictures cannot be: a card, how many, and what it sold for,
/// on its first line only so a card listed twice is not counted twice.
pub struct ListedCard {
    pub name: String,
    pub quantity: u32,
    pub value: Option<SaleValue>,
}

/// An order's cards as a list: from the pull sheet when it has the order's cards, else from the
/// order's lines, one row per card.
pub fn listed(order: &Order, sheet: &[Item]) -> Vec<ListedCard> {
    if !sheet.is_empty() {
        let mut seen = Vec::new();
        return sheet
            .iter()
            .map(|item| {
                let first = !seen.contains(&item.sku_id);
                seen.push(item.sku_id);
                ListedCard {
                    name: item.product_name.clone(),
                    quantity: item.quantity,
                    value: first.then(|| {
                        value::of_lines([order], |l| l.sku_id.is_some() && l.sku_id == item.sku_id)
                    }),
                }
            })
            .collect();
    }
    let key = |line: &Line| {
        line.inventory_sku()
            .map_or_else(|| format!("name:{}", line.name), |s| format!("sku:{s}"))
    };
    let mut groups: BTreeMap<(usize, String), (String, u32)> = BTreeMap::new();
    let mut first_at: Vec<(String, usize)> = Vec::new();
    for (i, line) in order.lines().iter().enumerate() {
        let k = key(line);
        let at = match first_at.iter().find(|(seen, _)| *seen == k) {
            Some((_, at)) => *at,
            None => {
                first_at.push((k.clone(), i));
                i
            }
        };
        groups
            .entry((at, k))
            .or_insert_with(|| (line.name.clone(), 0))
            .1 += line.quantity;
    }
    groups
        .into_iter()
        .map(|((_, k), (name, quantity))| ListedCard {
            name,
            quantity,
            value: Some(value::of_lines([order], |l| key(l) == k)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::shipping_export::orders::tests::order;

    fn item(name: &str, sku: i64, orders: &str) -> Item {
        Item {
            product_line: "Pokemon".into(),
            product_name: name.into(),
            condition: "Near Mint".into(),
            number: "1".into(),
            set: "Base".into(),
            release_year: None,
            rarity: "Rare".into(),
            quantity: 9,
            order_quantity: orders.into(),
            sku_id: Some(sku),
            catalog: None,
        }
    }

    fn line(name: &str, sku: i64, quantity: u32) -> Line {
        Line {
            name: name.into(),
            quantity,
            unit_price: 1.0,
            sku_id: Some(sku),
            product_id: None,
            inventory_sku_id: None,
            market_price: None,
        }
    }

    fn ordered(number: &str, lines: Vec<Line>) -> Order {
        Order {
            products: Some(lines),
            ..order(number)
        }
    }

    #[test]
    fn order_quantities_read_each_order_or_none() {
        assert_eq!(
            order_quantities("A-1:2 | B:1"),
            Some(vec![("A-1", 2), ("B", 1)])
        );
        assert_eq!(order_quantities("A:0"), None);
        assert_eq!(order_quantities("A"), None);
        assert_eq!(order_quantities(" "), None);
    }

    #[test]
    fn a_shipment_takes_its_orders_quantities_of_each_card() {
        let sheet = [item("Pikachu", 1, "A:2|B:1"), item("Mew", 2, "C:1")];
        let (a, b) = (
            ordered("A", vec![line("Pikachu", 1, 2)]),
            ordered("B", vec![line("Pikachu", 1, 1)]),
        );
        let m = matched(&sheet, &[&a, &b]);
        assert!(m.as_pictures());
        assert_eq!(m.items.len(), 1);
        assert_eq!(m.items[0].quantity, 3);
        assert_eq!(of_order(&m.items, "B")[0].quantity, 1);
    }

    #[test]
    fn a_shipment_the_sheet_does_not_cover_is_listed() {
        let a = ordered("A", vec![line("Pikachu", 1, 2)]);
        let short = matched(&[item("Pikachu", 1, "A:1")], &[&a]);
        assert_eq!(
            short.fallback,
            Some("Visual pull sheet matching was incomplete for this shipment.")
        );
        let unreadable = matched(&[item("Pikachu", 1, "A:2"), item("Mew", 2, "")], &[&a]);
        assert_eq!(
            unreadable.fallback,
            Some("Pull sheet order data was missing or malformed for this shipment.")
        );
        let bare = matched(&[item("Pikachu", 1, "A:2")], &[&order("A")]);
        assert_eq!(
            bare.fallback,
            Some("Line item details unavailable for this shipment.")
        );
    }

    #[test]
    fn an_orders_lines_are_listed_once_per_card_in_order() {
        let a = ordered(
            "A",
            vec![line("Mew", 2, 1), line("Pikachu", 1, 1), line("Mew", 2, 2)],
        );
        let rows = listed(&a, &[]);
        let shown: Vec<(&str, u32)> = rows.iter().map(|r| (r.name.as_str(), r.quantity)).collect();
        assert_eq!(shown, [("Mew", 3), ("Pikachu", 1)]);
    }
}
