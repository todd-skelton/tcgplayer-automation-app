//! The workflow's steps, in the order the operator works through them, and where the current one
//! stands (ported from `services/shippingStepProgress.ts`).
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    #[default]
    LoadOrders,
    PullSheet,
    BuyPostage,
    Print,
    Pack,
    Ship,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::LoadOrders,
        Step::PullSheet,
        Step::BuyPostage,
        Step::Print,
        Step::Pack,
        Step::Ship,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Step::LoadOrders => "Load Orders",
            Step::PullSheet => "Pull Sheet",
            Step::BuyPostage => "Buy Postage",
            Step::Print => "Print",
            Step::Pack => "Pack",
            Step::Ship => "Ship",
        }
    }

    fn index(self) -> usize {
        Step::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }

    pub fn previous(self) -> Option<Step> {
        self.index().checked_sub(1).map(|i| Step::ALL[i])
    }

    pub fn next(self) -> Option<Step> {
        Step::ALL.get(self.index() + 1).copied()
    }

    pub fn before(self, other: Step) -> bool {
        self.index() < other.index()
    }
}

/// The counts each step's standing is described from.
#[derive(Clone, Copy, Debug, Default)]
pub struct Counts {
    pub orders: usize,
    pub items: u32,
    pub shipments: usize,
    pub purchased: usize,
    pub packed: usize,
    /// Orders still to mark shipped or whose buyer is still to hear.
    pub unshipped: usize,
    /// Orders with production postage that are tracked and whose buyer heard.
    pub shipped: usize,
    pub has_seller: bool,
}

/// Where the current step stands and whether the workflow may move past it.
#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub summary: String,
    /// False while the step still has work Continue should wait for.
    pub ready: bool,
    /// Whether the operator may move on before it is ready.
    pub can_skip: bool,
}

fn count(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

impl Step {
    pub fn progress(self, c: Counts) -> Progress {
        let (summary, ready, can_skip) = match self {
            Step::LoadOrders => (
                if c.orders > 0 {
                    format!("{} loaded", count(c.orders, "order"))
                } else {
                    "No orders loaded".to_owned()
                },
                c.orders > 0,
                false,
            ),
            Step::PullSheet => (
                format!(
                    "{} to pull for {}",
                    count(c.items as usize, "card"),
                    count(c.orders, "order")
                ),
                true,
                false,
            ),
            Step::BuyPostage => (
                format!(
                    "Postage bought for {} of {}",
                    c.purchased,
                    count(c.shipments, "shipment")
                ),
                c.shipments > 0 && c.purchased == c.shipments,
                c.shipments > 0,
            ),
            Step::Print => (
                format!("{} ready to print", count(c.purchased, "label")),
                true,
                false,
            ),
            Step::Pack => (
                format!("{} of {} packed", c.packed, count(c.shipments, "shipment")),
                c.packed > 0,
                true,
            ),
            Step::Ship => (
                if c.unshipped > 0 && !c.has_seller {
                    "Set the seller key to notify buyers".to_owned()
                } else if c.unshipped > 0 {
                    format!("{} to mark shipped and notify", count(c.unshipped, "order"))
                } else if c.shipped > 0 {
                    "Every order is shipped and its buyer notified".to_owned()
                } else {
                    "No orders have production postage".to_owned()
                },
                true,
                false,
            ),
        };
        Progress {
            summary,
            ready,
            can_skip,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postage_waits_for_every_shipment_but_may_be_skipped() {
        let c = Counts {
            shipments: 3,
            purchased: 1,
            ..Counts::default()
        };
        assert_eq!(
            Step::BuyPostage.progress(c),
            Progress {
                summary: "Postage bought for 1 of 3 shipments".into(),
                ready: false,
                can_skip: true
            }
        );
        let one = Counts {
            orders: 1,
            ..Counts::default()
        };
        assert_eq!(Step::LoadOrders.progress(one).summary, "1 order loaded");
        assert_eq!(
            Step::Ship
                .progress(Counts {
                    unshipped: 2,
                    ..Counts::default()
                })
                .summary,
            "Set the seller key to notify buyers"
        );
    }

    #[test]
    fn the_steps_run_in_order() {
        assert_eq!(Step::LoadOrders.previous(), None);
        assert_eq!(Step::Print.next(), Some(Step::Pack));
        assert_eq!(Step::Ship.next(), None);
        assert!(Step::PullSheet.before(Step::Pack));
    }
}
