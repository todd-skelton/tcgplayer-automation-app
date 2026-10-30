//! What a card, order, shipment or batch sold for, against the current market and the market when
//! its cards came into inventory, and how long they were held (ported from `services/saleValue.ts`,
//! `orderMarketComparison.ts` and `orderIntakeComparison.ts`). Amounts are dollars, as the Node app
//! sends them; a view writes them as money.
use std::collections::{BTreeSet, HashMap};

use super::orders::{Line, Order};

/// A value the sale is measured against.
#[derive(Clone, Debug, PartialEq)]
pub struct Comparison {
    /// What the units this comparison covers sold for.
    pub price: f64,
    /// Their reference value, such as the current market.
    pub total: f64,
    /// `price - total`: above it when positive.
    pub difference: f64,
    /// The difference as a part of `total`, when it has one.
    pub ratio: Option<f64>,
    /// What part of the sale it covers, when not all of it.
    pub partial: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SaleValue {
    pub price: f64,
    pub market: Option<Comparison>,
    pub intake: Option<Comparison>,
    pub age_days: Option<f64>,
    pub age_partial: Option<String>,
}

/// Sold against the market, over the lines the market priced.
#[derive(Default)]
struct Market {
    sold: f64,
    comparable_sold: f64,
    comparable_market: f64,
    lines: u32,
    comparable_lines: u32,
}

impl Market {
    fn of(order: &Order) -> Market {
        let lines = order.lines();
        if lines.is_empty() {
            return Market {
                sold: order.value_of_products,
                ..Market::default()
            };
        }
        let mut market = Market::default();
        for line in lines {
            market.sold += line.sold();
            market.lines += 1;
            if let Some(price) = line.market_price.filter(|p| *p > 0.0) {
                market.comparable_sold += line.sold();
                market.comparable_market += price * f64::from(line.quantity);
                market.comparable_lines += 1;
            }
        }
        market
    }

    fn add(mut self, other: Market) -> Market {
        self.sold += other.sold;
        self.comparable_sold += other.comparable_sold;
        self.comparable_market += other.comparable_market;
        self.lines += other.lines;
        self.comparable_lines += other.comparable_lines;
        self
    }

    fn comparison(&self) -> Option<Comparison> {
        if self.comparable_lines == 0 || self.comparable_market <= 0.0 {
            return None;
        }
        let difference = self.comparable_sold - self.comparable_market;
        let partial = if self.lines == 0 {
            Some("No line items".to_owned())
        } else if self.comparable_lines == self.lines {
            None
        } else {
            let noun = if self.lines == 1 { "line" } else { "lines" };
            Some(format!(
                "{} of {} {noun} priced",
                self.comparable_lines, self.lines
            ))
        };
        Some(Comparison {
            price: self.comparable_sold,
            total: self.comparable_market,
            difference,
            ratio: Some(difference / self.comparable_market),
            partial,
        })
    }
}

/// Sold against the market when the cards came in, over the units whose intake price is known.
#[derive(Default)]
struct Intake {
    comparable_sold: f64,
    market: f64,
    ordered: u32,
    price_known: u32,
    date_known: u32,
    /// Days held times the units with a known date.
    weighted_days: f64,
}

impl Intake {
    fn of(order: &Order) -> Intake {
        let mut intake = Intake {
            ordered: order.item_count,
            ..Intake::default()
        };
        let Some(history) = &order.intake_history else {
            return intake;
        };
        let sold_total = if order.lines().is_empty() {
            order.value_of_products
        } else {
            order.lines().iter().map(Line::sold).sum()
        };
        let mut sold: HashMap<String, (u32, f64)> = HashMap::new();
        for line in order.lines() {
            if let Some(sku) = line.inventory_sku() {
                let entry = sold.entry(sku).or_default();
                entry.0 += line.quantity;
                entry.1 += line.sold();
            }
        }
        let history_quantity: u32 = history.lines.iter().map(|l| l.ordered_quantity).sum();
        let fallback = if history_quantity > 0 {
            sold_total / f64::from(history_quantity)
        } else {
            0.0
        };
        for line in history.lines.iter().filter(|l| l.status == "current") {
            let average = match (sold.get(&line.sku_id), line.sold_total) {
                (Some((quantity, total)), _) if *quantity > 0 => total / f64::from(*quantity),
                (_, Some(total)) if line.ordered_quantity > 0 => {
                    total / f64::from(line.ordered_quantity)
                }
                _ => fallback,
            };
            intake.price_known += line.price_known_quantity;
            intake.date_known += line.date_known_quantity;
            intake.comparable_sold += average * f64::from(line.price_known_quantity);
            intake.market += line.intake_market_total.unwrap_or(0.0);
            if let Some(days) = line.weighted_days_held {
                intake.weighted_days += days * f64::from(line.date_known_quantity);
            }
        }
        intake
    }

    fn add(mut self, other: Intake) -> Intake {
        self.comparable_sold += other.comparable_sold;
        self.market += other.market;
        self.ordered += other.ordered;
        self.price_known += other.price_known;
        self.date_known += other.date_known;
        self.weighted_days += other.weighted_days;
        self
    }

    fn comparison(&self) -> Option<Comparison> {
        if self.price_known == 0 {
            return None;
        }
        let difference = self.comparable_sold - self.market;
        Some(Comparison {
            price: self.comparable_sold,
            total: self.market,
            difference,
            ratio: (self.market != 0.0).then(|| difference / self.market),
            partial: (self.price_known < self.ordered).then(|| {
                format!(
                    "{} of {} units have an intake price",
                    self.price_known, self.ordered
                )
            }),
        })
    }

    fn age(&self) -> Option<f64> {
        (self.date_known > 0).then(|| self.weighted_days / f64::from(self.date_known))
    }
}

/// The value of these orders, each counted once (`saleValueOfOrders`).
pub fn of_orders<'a>(orders: impl IntoIterator<Item = &'a Order>) -> SaleValue {
    let mut seen = BTreeSet::new();
    let (market, intake) = orders
        .into_iter()
        .filter(|o| seen.insert(o.number.as_str()))
        .fold(
            (Market::default(), Intake::default()),
            |(market, intake), order| {
                (market.add(Market::of(order)), intake.add(Intake::of(order)))
            },
        );
    let age_days = intake.age();
    SaleValue {
        price: market.sold,
        market: market.comparison(),
        intake: intake.comparison(),
        age_days,
        age_partial: (age_days.is_some() && intake.date_known < intake.ordered).then(|| {
            format!(
                "{} of {} units have an intake date",
                intake.date_known, intake.ordered
            )
        }),
    }
}

/// One card's sale across the orders: each order narrowed to that card's lines and history.
pub fn of_card<'a>(orders: impl IntoIterator<Item = &'a Order>, sku_id: i64) -> SaleValue {
    of_lines(orders, |l| l.sku_id == Some(sku_id))
}

/// The sale of the lines `keep` picks across the orders (`saleValueOfLines`): each order
/// narrowed to those lines and their history.
pub fn of_lines<'a>(
    orders: impl IntoIterator<Item = &'a Order>,
    keep: impl Fn(&Line) -> bool,
) -> SaleValue {
    let narrowed: Vec<Order> = orders
        .into_iter()
        .filter_map(|order| {
            let lines: Vec<Line> = order.lines().iter().filter(|l| keep(l)).cloned().collect();
            if lines.is_empty() {
                return None;
            }
            let skus: BTreeSet<String> = lines.iter().filter_map(Line::inventory_sku).collect();
            let mut history = order.intake_history.clone();
            if let Some(h) = &mut history {
                h.lines.retain(|l| skus.contains(&l.sku_id));
            }
            Some(Order {
                item_count: lines.iter().map(|l| l.quantity).sum(),
                value_of_products: lines.iter().map(Line::sold).sum(),
                products: Some(lines),
                intake_history: history,
                ..order.clone()
            })
        })
        .collect();
    of_orders(&narrowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::shipping_export::orders::{IntakeHistory, IntakeLine, tests::order};

    fn line(sku: i64, quantity: u32, price: f64, market: Option<f64>) -> Line {
        Line {
            name: format!("Card {sku}"),
            quantity,
            unit_price: price,
            sku_id: Some(sku),
            product_id: None,
            inventory_sku_id: Some(sku.to_string()),
            market_price: market,
        }
    }

    #[test]
    fn the_market_comparison_covers_only_the_priced_lines() {
        let mut o = order("A");
        o.products = Some(vec![line(1, 2, 1.0, Some(0.8)), line(2, 1, 3.0, None)]);
        let value = of_orders([&o, &o]);
        assert_eq!(value.price, 5.0, "an order is counted once");
        let market = value.market.unwrap();
        assert_eq!((market.price, market.total), (2.0, 1.6));
        assert!((market.ratio.unwrap() - 0.25).abs() < 1e-9);
        assert_eq!(market.partial.as_deref(), Some("1 of 2 lines priced"));
        assert!(value.intake.is_none() && value.age_days.is_none());
    }

    #[test]
    fn the_intake_comparison_weighs_age_by_the_units_with_a_date() {
        let mut o = order("A");
        o.item_count = 3;
        o.products = Some(vec![line(1, 2, 2.0, None), line(2, 1, 4.0, None)]);
        let history_line = |sku: &str, known: u32, market: f64, days: f64| IntakeLine {
            sku_id: sku.into(),
            status: "current".into(),
            sold_total: None,
            ordered_quantity: known,
            price_known_quantity: known,
            date_known_quantity: known,
            intake_market_total: Some(market),
            weighted_days_held: Some(days),
        };
        o.intake_history = Some(IntakeHistory {
            order_number: "A".into(),
            seller_key: "s".into(),
            lines: vec![
                history_line("1", 2, 3.0, 10.0),
                history_line("2", 0, 0.0, 0.0),
            ],
            refreshed_at: "2026-10-01T00:00:00Z".into(),
        });
        let value = of_orders([&o]);
        let intake = value.intake.unwrap();
        assert_eq!(
            (intake.price, intake.total, intake.difference),
            (4.0, 3.0, 1.0)
        );
        assert_eq!(
            intake.partial.as_deref(),
            Some("2 of 3 units have an intake price")
        );
        assert_eq!(value.age_days, Some(10.0));
        let card = of_card([&o], 1);
        assert_eq!(card.price, 4.0);
        assert_eq!(card.intake.unwrap().partial, None);
    }
}
