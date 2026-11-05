//! The allocator: sold lines in order time take the earliest eligible stock, ported from
//! `allocateInventoryFifo.ts` to the same results, line for line.
use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};

use chrono::{DateTime, DurationRound, TimeDelta, Utc};

/// The largest integer JavaScript counts exactly, the bound Node checks its sums against.
const SAFE_INTEGER: i64 = (1 << 53) - 1;
const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;

/// Stock that can fill sold lines: a receipt, a return (disposition) or a quantity correction.
#[derive(Clone, Debug, PartialEq)]
pub struct SupplyLot {
    pub supply_key: String,
    pub receipt_id: i64,
    pub disposition_id: Option<String>,
    pub quantity_correction_id: Option<String>,
    /// Sold lines this stock may not fill: a return never fills the line it came back from.
    pub excluded_line_keys: Vec<String>,
    pub quantity: i64,
    pub available_at: DateTime<Utc>,
    /// 0 goes before 1: the opening balance is sold before anything received later.
    pub fifo_precedence: u8,
    pub intake_at: Option<DateTime<Utc>>,
    pub market_value_ten_thousandths: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrderLine {
    pub line_key: String,
    pub order_id: String,
    pub order_number: String,
    pub order_time: DateTime<Utc>,
    pub quantity: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    pub supply_key: String,
    pub receipt_id: i64,
    pub disposition_id: Option<String>,
    pub quantity_correction_id: Option<String>,
    pub quantity: i64,
    pub available_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LineResult {
    pub line_key: String,
    pub allocations: Vec<Allocation>,
    pub requested_quantity: i64,
    pub matched_quantity: i64,
    pub unmatched_quantity: i64,
    pub price_known_quantity: i64,
    pub intake_market_total_cents: Option<i64>,
    pub date_known_quantity: i64,
    pub weighted_days_held: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    SupplyQuantity,
    MarketValue,
    OrderQuantity,
    DuplicateSupplyKey,
    MarketTotalOutOfBounds,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SupplyQuantity => "FIFO supply quantities must be positive safe integers.",
            Self::MarketValue => "FIFO market values must be nonnegative integer ten-thousandths.",
            Self::OrderQuantity => "FIFO order quantities must be nonnegative safe integers.",
            Self::DuplicateSupplyKey => "FIFO supply keys must be unique.",
            Self::MarketTotalOutOfBounds => "FIFO market total exceeds safe arithmetic bounds.",
        })
    }
}

impl std::error::Error for Refused {}

/// Node compares times as millisecond ISO text, so finer precision would order ties differently.
fn to_millisecond(time: DateTime<Utc>) -> DateTime<Utc> {
    time.duration_trunc(TimeDelta::milliseconds(1))
        .unwrap_or(time)
}

fn fifo_order(left: &SupplyLot, right: &SupplyLot) -> Ordering {
    left.fifo_precedence
        .cmp(&right.fifo_precedence)
        // An unknown intake is the oldest stock.
        .then_with(|| left.intake_at.cmp(&right.intake_at))
        .then_with(|| left.receipt_id.cmp(&right.receipt_id))
        .then_with(|| left.supply_key.cmp(&right.supply_key))
}

fn sale_order(left: &OrderLine, right: &OrderLine) -> Ordering {
    left.order_time
        .cmp(&right.order_time)
        .then_with(|| left.order_number.cmp(&right.order_number))
        .then_with(|| left.order_id.cmp(&right.order_id))
        .then_with(|| left.line_key.cmp(&right.line_key))
}

/// A lot in the heap of stock on hand, the next to sell on top.
struct Eligible(SupplyLot);

impl PartialEq for Eligible {
    fn eq(&self, other: &Self) -> bool {
        fifo_order(&self.0, &other.0) == Ordering::Equal
    }
}
impl Eq for Eligible {}
impl PartialOrd for Eligible {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Eligible {
    fn cmp(&self, other: &Self) -> Ordering {
        fifo_order(&self.0, &other.0)
    }
}

fn safe(value: i64) -> bool {
    (-SAFE_INTEGER..=SAFE_INTEGER).contains(&value)
}

/// Fills each line, in order time, from the stock available by then, oldest intake first.
/// Results come back in that order.
pub fn allocate(lines: &[OrderLine], lots: &[SupplyLot]) -> Result<Vec<LineResult>, Refused> {
    for lot in lots {
        if lot.quantity <= 0 || !safe(lot.quantity) {
            return Err(Refused::SupplyQuantity);
        }
        if lot
            .market_value_ten_thousandths
            .is_some_and(|value| value < 0 || !safe(value))
        {
            return Err(Refused::MarketValue);
        }
    }
    if lines
        .iter()
        .any(|line| line.quantity < 0 || !safe(line.quantity))
    {
        return Err(Refused::OrderQuantity);
    }
    let mut remaining: HashMap<&str, i64> = lots
        .iter()
        .map(|lot| (lot.supply_key.as_str(), lot.quantity))
        .collect();
    if remaining.len() != lots.len() {
        return Err(Refused::DuplicateSupplyKey);
    }
    let mut lots: Vec<SupplyLot> = lots
        .iter()
        .map(|lot| SupplyLot {
            available_at: to_millisecond(lot.available_at),
            intake_at: lot.intake_at.map(to_millisecond),
            ..lot.clone()
        })
        .collect();
    lots.sort_by(|left, right| {
        left.available_at
            .cmp(&right.available_at)
            .then_with(|| fifo_order(left, right))
    });
    let mut lines: Vec<OrderLine> = lines
        .iter()
        .map(|line| OrderLine {
            order_time: to_millisecond(line.order_time),
            ..line.clone()
        })
        .collect();
    lines.sort_by(sale_order);

    let mut arriving = lots.into_iter().peekable();
    let mut eligible = BinaryHeap::new();
    let mut results = Vec::with_capacity(lines.len());
    for line in lines {
        while let Some(lot) = arriving.next_if(|lot| lot.available_at <= line.order_time) {
            eligible.push(Reverse(Eligible(lot)));
        }
        let mut needed = line.quantity;
        let mut price_known_quantity = 0;
        let mut market_total = 0_i64;
        let mut date_known_quantity = 0;
        let mut weighted_day_quantity = 0.0_f64;
        let mut allocations = Vec::new();
        let mut excluded = Vec::new();
        while needed > 0 {
            let Some(Reverse(Eligible(lot))) = eligible.peek() else {
                break;
            };
            if lot.excluded_line_keys.contains(&line.line_key) {
                excluded.extend(eligible.pop());
                continue;
            }
            let available = remaining.get(lot.supply_key.as_str()).copied().unwrap_or(0);
            if available <= 0 {
                eligible.pop();
                continue;
            }
            let quantity = available.min(needed);
            if let Some(left) = remaining.get_mut(lot.supply_key.as_str()) {
                *left = available - quantity;
            }
            needed -= quantity;
            allocations.push(Allocation {
                supply_key: lot.supply_key.clone(),
                receipt_id: lot.receipt_id,
                disposition_id: lot.disposition_id.clone(),
                quantity_correction_id: lot.quantity_correction_id.clone(),
                quantity,
                available_at: lot.available_at,
            });
            if let Some(value) = lot.market_value_ten_thousandths {
                price_known_quantity += quantity;
                market_total = quantity
                    .checked_mul(value)
                    .and_then(|added| market_total.checked_add(added))
                    .filter(|total| safe(*total))
                    .ok_or(Refused::MarketTotalOutOfBounds)?;
            }
            if let Some(intake_at) = lot.intake_at {
                date_known_quantity += quantity;
                let held = (line.order_time - intake_at).num_milliseconds() as f64;
                weighted_day_quantity += quantity as f64 * held / MILLISECONDS_PER_DAY;
            }
            if available == quantity {
                eligible.pop();
            }
        }
        eligible.extend(excluded);
        results.push(LineResult {
            line_key: line.line_key,
            allocations,
            requested_quantity: line.quantity,
            matched_quantity: line.quantity - needed,
            unmatched_quantity: needed,
            price_known_quantity,
            // Math.round of a nonnegative total: halves round up.
            intake_market_total_cents: (price_known_quantity > 0)
                .then(|| (market_total + 50) / 100),
            date_known_quantity,
            weighted_days_held: (date_known_quantity > 0)
                .then(|| weighted_day_quantity / date_known_quantity as f64),
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a test time")
            .with_timezone(&Utc)
    }

    const SALE: &str = "2026-09-07T00:00:00.000Z";

    fn lot(supply_key: &str, receipt_id: i64, quantity: i64) -> SupplyLot {
        SupplyLot {
            supply_key: supply_key.into(),
            receipt_id,
            disposition_id: None,
            quantity_correction_id: None,
            excluded_line_keys: Vec::new(),
            quantity,
            available_at: at("2026-01-01T00:00:00.000Z"),
            fifo_precedence: 1,
            intake_at: Some(at("2026-01-01T00:00:00.000Z")),
            market_value_ten_thousandths: None,
        }
    }

    fn line(
        line_key: &str,
        order_id: &str,
        order_number: &str,
        order_time: &str,
        quantity: i64,
    ) -> OrderLine {
        OrderLine {
            line_key: line_key.into(),
            order_id: order_id.into(),
            order_number: order_number.into(),
            order_time: at(order_time),
            quantity,
        }
    }

    #[test]
    fn weights_market_value_and_days_held_by_quantity() {
        let first = SupplyLot {
            intake_at: Some(at("2026-07-09T00:00:00.000Z")),
            market_value_ten_thousandths: Some(40_000),
            ..lot("r1", 1, 2)
        };
        let second = SupplyLot {
            intake_at: Some(at("2026-08-28T00:00:00.000Z")),
            market_value_ten_thousandths: Some(60_000),
            ..lot("r2", 2, 1)
        };
        let weighted = allocate(&[line("sale", "1", "A", SALE, 3)], &[first, second])
            .unwrap()
            .remove(0);
        assert_eq!(weighted.intake_market_total_cents, Some(1400));
        assert_eq!(
            format!("{:.1}", weighted.weighted_days_held.unwrap()),
            "43.3"
        );
        assert_eq!(weighted.matched_quantity, 3);
    }

    #[test]
    fn splits_eligible_lots_with_independent_coverage() {
        let split = allocate(
            &[
                line("later", "3", "B", SALE, 2),
                line("earlier", "2", "A", "2026-09-06T00:00:00.000Z", 2),
            ],
            &[
                SupplyLot {
                    fifo_precedence: 0,
                    intake_at: None,
                    ..lot("opening", 1, 1)
                },
                SupplyLot {
                    market_value_ten_thousandths: Some(40_000),
                    ..lot("known", 2, 2)
                },
                SupplyLot {
                    available_at: at("2026-09-08T00:00:00.000Z"),
                    ..lot("future", 3, 5)
                },
            ],
        )
        .unwrap();
        let shape: Vec<_> = split
            .iter()
            .map(|l| {
                (
                    l.line_key.as_str(),
                    l.matched_quantity,
                    l.unmatched_quantity,
                )
            })
            .collect();
        assert_eq!(shape, [("earlier", 2, 0), ("later", 1, 1)]);
        assert_eq!(split[0].allocations[0].supply_key, "opening");
        assert_eq!(split[0].date_known_quantity, 1);
        assert_eq!(split[0].price_known_quantity, 1);
    }

    #[test]
    fn breaks_ties_by_order_number_and_receipt() {
        let ties = allocate(
            &[
                line("order-b", "2", "B", SALE, 1),
                line("order-a", "1", "A", SALE, 1),
            ],
            &[lot("receipt-2", 2, 1), lot("receipt-1", 1, 1)],
        )
        .unwrap();
        let shape: Vec<_> = ties
            .iter()
            .map(|l| (l.line_key.as_str(), l.allocations[0].supply_key.as_str()))
            .collect();
        assert_eq!(shape, [("order-a", "receipt-1"), ("order-b", "receipt-2")]);
    }

    #[test]
    fn keeps_fractional_and_zero_market_values() {
        let precise = allocate(
            &[
                line("fractional", "4", "C", SALE, 100),
                line("zero", "5", "D", SALE, 1),
            ],
            &[
                SupplyLot {
                    market_value_ten_thousandths: Some(12_345),
                    ..lot("fractional", 4, 100)
                },
                SupplyLot {
                    market_value_ten_thousandths: Some(0),
                    ..lot("zero", 5, 1)
                },
            ],
        )
        .unwrap();
        assert_eq!(precise[0].intake_market_total_cents, Some(12_345));
        assert_eq!(precise[0].price_known_quantity, 100);
        assert_eq!(precise[1].intake_market_total_cents, Some(0));
        assert_eq!(precise[1].price_known_quantity, 1);
    }

    #[test]
    fn rounds_half_cents_up_like_math_round() {
        let half = allocate(
            &[line("half", "1", "A", SALE, 1)],
            &[SupplyLot {
                market_value_ten_thousandths: Some(12_350),
                ..lot("half", 1, 1)
            }],
        )
        .unwrap();
        assert_eq!(half[0].intake_market_total_cents, Some(124));
    }

    #[test]
    fn a_return_never_fills_the_line_it_came_back_from() {
        let lines = [
            line("origin", "6", "F", SALE, 1),
            line("next", "7", "G", SALE, 1),
        ];
        let returned = SupplyLot {
            excluded_line_keys: vec!["origin".into()],
            ..lot("returned", 9, 1)
        };
        let results = allocate(&lines, &[returned]).unwrap();
        assert_eq!(results[0].unmatched_quantity, 1);
        assert_eq!(results[1].allocations[0].supply_key, "returned");
    }

    #[test]
    fn refuses_what_node_refuses() {
        assert_eq!(
            allocate(&[], &[lot("none", 1, 0)]),
            Err(Refused::SupplyQuantity)
        );
        let negative = SupplyLot {
            market_value_ten_thousandths: Some(-1),
            ..lot("negative", 1, 1)
        };
        assert_eq!(allocate(&[], &[negative]), Err(Refused::MarketValue));
        assert_eq!(
            allocate(&[line("l", "1", "A", SALE, -1)], &[]),
            Err(Refused::OrderQuantity)
        );
        assert_eq!(
            allocate(&[], &[lot("same", 1, 1), lot("same", 2, 1)]),
            Err(Refused::DuplicateSupplyKey)
        );
    }

    #[test]
    fn replays_twenty_thousand_lines_in_one_pass() {
        let volume = 20_000;
        let lines: Vec<_> = (0..volume)
            .map(|index| {
                line(
                    &format!("line-{index}"),
                    &(index + 1).to_string(),
                    &format!("{index:08}"),
                    "2026-09-07T00:00:00-05:00",
                    1,
                )
            })
            .collect();
        let lots: Vec<_> = (0..volume)
            .map(|index| SupplyLot {
                available_at: at("2026-09-07T04:59:59.000Z"),
                intake_at: None,
                ..lot(&format!("lot-{index}"), i64::from(index) + 10, 1)
            })
            .collect();
        let many = allocate(&lines, &lots).unwrap();
        assert_eq!(many.len(), 20_000);
        assert_eq!(many.iter().map(|l| l.matched_quantity).sum::<i64>(), 20_000);
    }
}
