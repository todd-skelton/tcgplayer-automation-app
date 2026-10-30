use corten::prelude::*;

use crate::{
    features::shipping_export::ship::{Messaged, Tracked},
    layout::{Notice, Tone},
};

/// The Ship step as it stands: what is still to send and what came back each time it was sent.
pub struct Shipping<'a> {
    /// Buyers are told with the seller's key, so without one nothing is sent.
    pub has_seller: bool,
    /// Orders with tracking still to apply or a buyer still to tell.
    pub pending: Vec<&'a str>,
    /// Orders with production postage that are tracked and whose buyer heard.
    pub shipped: usize,
    pub tracked: &'a [Tracked],
    pub messaged: &'a [Messaged],
}

/// One order's results: its tracking, then its buyer's message, as far as each went.
#[derive(Debug, PartialEq)]
struct Outcome<'a> {
    order: &'a str,
    tracked: Option<&'a Tracked>,
    messaged: Option<&'a Messaged>,
}

impl<'a> Shipping<'a> {
    /// Each order sent, in the order its tracking was, then the orders only messaged.
    fn outcomes(&self) -> Vec<Outcome<'a>> {
        let mut outcomes: Vec<Outcome<'a>> = self
            .tracked
            .iter()
            .map(|t| Outcome {
                order: &t.order_number,
                tracked: Some(t),
                messaged: None,
            })
            .collect();
        for m in self.messaged {
            match outcomes.iter_mut().find(|o| o.order == m.order_number) {
                Some(outcome) => outcome.messaged = Some(m),
                None => outcomes.push(Outcome {
                    order: &m.order_number,
                    tracked: None,
                    messaged: Some(m),
                }),
            }
        }
        outcomes
    }

    fn readiness(&self) -> String {
        if !self.pending.is_empty() {
            format!(
                "{} ready to mark as shipped in TCGPlayer and notify the buyer.",
                plural(self.pending.len(), "order")
            )
        } else if self.shipped > 0 {
            "Every order with production postage is marked shipped and its buyer notified.".into()
        } else {
            "No orders have production postage. Buy postage in production mode first.".into()
        }
    }
}

impl Outcome<'_> {
    fn failed(&self) -> bool {
        self.tracked.is_some_and(|t| t.status == "failed")
            || self.messaged.is_some_and(|m| m.status == "failed")
    }

    fn errors(&self) -> String {
        [
            self.tracked.and_then(|t| t.error.as_deref()),
            self.messaged.and_then(|m| m.error.as_deref()),
        ]
        .into_iter()
        .flatten()
        .filter(|e| !e.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
    }
}

fn plural(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// Marks the orders shipped on TCGplayer with their tracking, then tells each buyer: what is
/// ready, what failed, and each order's results.
#[component(css)]
pub fn ShipStep<'a>(shipping: &'a Shipping<'a>) -> impl Render {
    let outcomes = shipping.outcomes();
    let failed = outcomes.iter().filter(|o| o.failed()).count();
    let complete = shipping.pending.is_empty() && shipping.shipped > 0 && failed == 0;
    html! {
        <div class={ShipStep}>
            if shipping.has_seller {
                <p>{shipping.readiness()}</p>
                if !shipping.pending.is_empty() {
                    <ul class={Pending} aria-label="Orders to ship">
                        for order in &shipping.pending { <li class={Chip}>{*order}</li> }
                    </ul>
                }
            } else {
                <Notice tone={Tone::Warning}>
                    "Set the seller key on Load Orders before shipping. Buyers can only be notified with it."
                </Notice>
            }
            if failed > 0 {
                <Notice tone={Tone::Warning}>
                    {plural(failed, "order")}
                    " could not be completed. Shipping again retries only those orders; an order whose tracking failed is not messaged."
                </Notice>
            }
            if complete {
                <Notice tone={Tone::Done}>
                    "Batch complete. Every order is shipped and its buyer notified."
                </Notice>
            }
            if !outcomes.is_empty() {
                <div class={Scroll}>
                    <table class={Outcomes}>
                        <thead>
                            <tr>
                                <th>"Order"</th>
                                <th>"Tracking"</th>
                                <th>"Tracking number"</th>
                                <th>"Shipped message"</th>
                                <th>"Error"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for outcome in &outcomes {
                                <tr>
                                    <td>{outcome.order}</td>
                                    <td>
                                        <Status
                                            label={outcome.tracked.map(|t| t.status.as_str())}
                                            succeeded="applied"
                                        />
                                    </td>
                                    <td>
                                        {outcome.tracked.map_or("-", |t| t.tracking_number.as_str())}
                                    </td>
                                    <td>
                                        <Status
                                            label={outcome.messaged.map(|m| m.status.as_str())}
                                            succeeded="sent"
                                        />
                                        if let Some(href) = outcome.messaged.and_then(|m| m.tracking_url.as_deref()) {
                                            " "
                                            <a href={href} target="_blank" rel="noreferrer">
                                                "Track"
                                            </a>
                                        }
                                    </td>
                                    <td class={Failed}>{outcome.errors()}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
        </div>
    }
}

/// A result's status as a chip, good when it is `succeeded`; a dash before it was sent.
#[component(css = ShipStep)]
fn Status<'a>(label: Option<&'a str>, succeeded: &'a str) -> impl Render {
    html! {
        if let Some(label) = label {
            <span class={(Chip, if label == succeeded { Good } else { Failed })}>{label}</span>
        } else {
            "-"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked(order: &str, status: &str) -> Tracked {
        Tracked {
            order_number: order.into(),
            carrier: "USPS".into(),
            tracking_number: format!("TRACK-{order}"),
            status: status.into(),
            error: (status == "failed").then(|| format!("{order} refused.")),
        }
    }

    fn messaged(order: &str, status: &str) -> Messaged {
        Messaged {
            order_number: order.into(),
            seller_key: "seller".into(),
            easypost_shipment_id: format!("shp_{order}"),
            tracking_url: None,
            status: status.into(),
            error: (status == "failed").then(|| format!("{order} not told.")),
        }
    }

    /// `outcomesByOrder`: each order once, tracking first, a message joining its order's row.
    #[test]
    fn each_order_shows_its_tracking_and_message_together() {
        let tracked = [tracked("A", "applied"), tracked("B", "failed")];
        let messaged = [messaged("A", "failed"), messaged("C", "sent")];
        let shipping = Shipping {
            has_seller: true,
            pending: vec!["A", "B"],
            shipped: 1,
            tracked: &tracked,
            messaged: &messaged,
        };
        let outcomes = shipping.outcomes();
        let orders: Vec<_> = outcomes.iter().map(|o| o.order).collect();
        assert_eq!(orders, ["A", "B", "C"]);
        assert_eq!(outcomes[0].messaged, Some(&messaged[0]));
        let failed: Vec<_> = outcomes
            .iter()
            .filter(|o| o.failed())
            .map(|o| o.order)
            .collect();
        assert_eq!(failed, ["A", "B"]);
        assert_eq!(outcomes[0].errors(), "A not told.");
        assert_eq!(
            shipping.readiness(),
            "2 orders ready to mark as shipped in TCGPlayer and notify the buyer."
        );
    }
}
