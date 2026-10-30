//! Label management (`LabelManagementPanel`): any one order looked up on TCGplayer, the labels
//! already bought for it, and an outbound label, a return label or both bought for it from the
//! order's own shipment, edited here only. The order on TCGplayer is not changed.
//!
//! The form's body is read twice, once as the shipment ([`ShipmentInput`]) and once as the
//! choice ([`Choice`]), since a form's fields cannot be flattened from a shared group (corten
//! #363).
use corten::{ClientZone, axum::body::Bytes, axum::http::StatusCode, form::from_bytes, prelude::*};
use serde::Deserialize;

use super::{
    buying::cannot_buy,
    editing::ShipmentInput,
    orders::Order,
    postage::{self, Bought, Scope, Status},
    shipments::{Direction, Planned, Shipment, shipment_for},
    source, url,
    views::{LabelForm, LabelManagement, Looked},
    workflow,
};
use crate::{
    database::Database,
    features::shipping_configuration::{self, EasyPostMode, Service, ShippingConfig},
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// Which labels to buy for the order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum LabelsToBuy {
    #[default]
    OutboundOnly,
    RoundTrip,
    ReturnOnly,
}

impl LabelsToBuy {
    pub const ALL: [LabelsToBuy; 3] = [
        LabelsToBuy::OutboundOnly,
        LabelsToBuy::RoundTrip,
        LabelsToBuy::ReturnOnly,
    ];

    /// Outbound first: a return is bought only after the outbound label it goes with.
    pub fn directions(self) -> &'static [Direction] {
        match self {
            LabelsToBuy::OutboundOnly => &[Direction::Outbound],
            LabelsToBuy::RoundTrip => &[Direction::Outbound, Direction::Return],
            LabelsToBuy::ReturnOnly => &[Direction::Return],
        }
    }

    /// What the buy button buys.
    pub fn label(self) -> &'static str {
        match self {
            LabelsToBuy::OutboundOnly => "Outbound Label",
            LabelsToBuy::RoundTrip => "Outbound + Return Labels",
            LabelsToBuy::ReturnOnly => "Return Label",
        }
    }
}

/// The form's other fields: the labels chosen, the service the package was drawn for (so a new
/// service redraws it), and whether the operator was told a label is already bought.
#[derive(Debug, Deserialize, Fields)]
pub struct Choice {
    #[serde(default)]
    pub buy: LabelsToBuy,
    pub shown_service: Option<Service>,
    #[serde(default)]
    pub again: bool,
}

/// The order and the labels bought for it, as far as each could be read.
pub struct Found {
    pub order: Order,
    pub shipment: Shipment,
    pub outbound: Option<Bought>,
    pub returned: Option<Bought>,
}

/// The labels bought for the order in each direction, as `directions` asks.
fn bought_of(found: &Found, directions: &[Direction]) -> Vec<Direction> {
    directions
        .iter()
        .copied()
        .filter(|d| {
            match d {
                Direction::Outbound => &found.outbound,
                Direction::Return => &found.returned,
            }
            .as_ref()
            .is_some_and(Bought::purchased)
        })
        .collect()
}

/// The seller the batch was loaded for, or the configured one.
async fn seller(db: &Database, config: &ShippingConfig) -> corten::Result<String> {
    let saved = workflow::current(db).await?;
    Ok(saved
        .map(|w| w.seller_key)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| config.default_seller_key.clone())
        .trim()
        .to_owned())
}

/// The order and the labels already bought for it, or why it could not be read.
async fn look_up(
    db: &Database,
    legacy: &Legacy,
    config: &ShippingConfig,
    number: &str,
) -> corten::Result<Result<Found, String>> {
    let seller = seller(db, config).await?;
    let order = match source::one(legacy, &seller, number).await {
        Ok(loaded) => loaded.orders.into_iter().next(),
        Err(why) => return Ok(Err(format!("Failed to load order: {why}"))),
    };
    let Some(order) = order else {
        return Ok(Err(format!("Order {number} was not found.")));
    };
    let shipment = shipment_for(&order, config);
    let one = [Planned {
        shipment: shipment.clone(),
        orders: vec![order.number.clone()],
    }];
    let (outbound, returned) = tokio::join!(
        postage::bought(legacy, Direction::Outbound, &one),
        postage::bought(legacy, Direction::Return, &one)
    );
    let reference = order.number.clone();
    let take = |p: Result<postage::Postage, String>, what: &str| match p {
        Ok(mut p) => Ok(p.remove(&reference)),
        Err(why) => Err(format!("Failed to load saved {what} postage: {why}")),
    };
    let (outbound, returned) = match (take(outbound, "outbound"), take(returned, "return")) {
        (Ok(o), Ok(r)) => (o, r),
        (Err(why), _) | (_, Err(why)) => return Ok(Err(why)),
    };
    Ok(Ok(Found {
        order,
        shipment,
        outbound,
        returned,
    }))
}

/// The panel as it is drawn: the order looked up, the form as sent when it was refused.
struct Draft<'a> {
    input: &'a ShipmentInput,
    buy: LabelsToBuy,
    errors: &'a Errors,
}

#[allow(clippy::too_many_arguments)]
async fn labels_page(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    number: Option<&str>,
    problem: Option<&str>,
    draft: Option<Draft<'_>>,
) -> HtmlResult {
    let (chrome, config) = tokio::join!(Chrome::read(db), shipping_configuration::settings(db));
    let config = config?;
    let number = number.map(str::trim).filter(|n| !n.is_empty());
    let found = match number {
        Some(n) => Some(look_up(db, legacy, &config, n).await?),
        None => None,
    };
    let lookup_problem = found.as_ref().and_then(|f| f.as_ref().err().cloned());
    let problem = problem.or(lookup_problem.as_deref());
    let found = found.and_then(Result::ok);
    // Read by the form and by the view, which owns what it uses, so both take the reference.
    let found = found.as_ref();
    let t: Msg = req.t();
    let mode = EasyPostMode::of_deployment();
    let seller = seller(db, &config).await?;
    let stored = found.map(|f| ShipmentInput::of(&f.shipment));
    let no_errors = Errors::new();
    let form = found.map(|f| {
        let (input, buy, errors) = match &draft {
            Some(d) => (d.input, d.buy, d.errors),
            None => (
                stored.as_ref().expect("stored with found"),
                LabelsToBuy::default(),
                &no_errors,
            ),
        };
        (f, input, buy, errors)
    });
    req.page(html! {
        <Layout req={req} title="Label Management" chrome={chrome} head="">
            <LabelManagement
                looked={&Looked { number, seller: &seller, problem, visitor, t }}
                found={found}
            >
                if let Some((found, input, buy, errors)) = form {
                    <LabelForm
                        number={&found.order.number}
                        input={input}
                        buy={buy}
                        bought={&bought_of(found, buy.directions())}
                        mode={mode}
                        errors={errors}
                    />
                }
            </LabelManagement>
        </Layout>
    })
}

pub async fn show_labels(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::OrderLabels>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    labels_page(&req, &db, &legacy, visitor, at.order.as_deref(), None, None).await
}

/// The form drawn again for what was chosen: a new service redraws the package for it (a
/// letter, weighed for the order, when it is First), keeping the address as edited.
pub async fn redraw_labels(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::OrderLabelsForm>,
    body: Bytes,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let number = at.order;
    let (Ok(input), Ok(choice)) = (
        from_bytes::<ShipmentInput>(&body),
        from_bytes::<Choice>(&body),
    ) else {
        return labels_page(&req, &db, &legacy, visitor, Some(&number), None, None).await;
    };
    let config = shipping_configuration::settings(&db).await?;
    let found = match look_up(&db, &legacy, &config, &number).await? {
        Ok(found) => found,
        Err(why) => {
            return refused(
                &req,
                &db,
                &legacy,
                visitor,
                &number,
                &why,
                kept(&input, &choice),
            )
            .await;
        }
    };
    let input = if choice.shown_service == Some(input.service) {
        input
    } else {
        let moved = input.with_address(&found.shipment);
        ShipmentInput::of(&moved.with_service(input.service, &config, Some(&found.order)))
    };
    let errors = Errors::new();
    req.patch(LabelForm {
        number: &found.order.number,
        input: &input,
        buy: choice.buy,
        bought: &bought_of(&found, choice.buy.directions()),
        mode: EasyPostMode::of_deployment(),
        errors: &errors,
    })
}

/// The labels chosen bought for the order, outbound first, stopping at the first not bought.
/// One already bought is bought again only when the form said so, as it does once it shows it.
pub async fn buy_labels(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::BuyOrderLabels>,
    body: Bytes,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let number = at.order;
    let mode = EasyPostMode::of_deployment();
    let (input, choice) = match (
        from_bytes::<ShipmentInput>(&body),
        from_bytes::<Choice>(&body),
    ) {
        (Ok(input), Ok(choice)) => (input, choice),
        (Err(why), _) | (_, Err(why)) => {
            return refused(&req, &db, &legacy, visitor, &number, &why.to_string(), None).await;
        }
    };
    let Some(_buying) = postage::BUYING.start() else {
        let why = "Postage is already being bought. Try again when that purchase finishes.";
        return refused(
            &req,
            &db,
            &legacy,
            visitor,
            &number,
            why,
            kept(&input, &choice),
        )
        .await;
    };
    if let Some(why) = cannot_buy(mode) {
        return refused(
            &req,
            &db,
            &legacy,
            visitor,
            &number,
            &why,
            kept(&input, &choice),
        )
        .await;
    }
    let config = shipping_configuration::settings(&db).await?;
    let found = match look_up(&db, &legacy, &config, &number).await? {
        Ok(found) => found,
        Err(why) => {
            return refused(
                &req,
                &db,
                &legacy,
                visitor,
                &number,
                &why,
                kept(&input, &choice),
            )
            .await;
        }
    };
    // The labels are the order's: its number is the reference, whatever the form says.
    let shipment = match input.read(&found.shipment, |_| false) {
        Ok(mut shipment) => {
            shipment.reference = found.order.number.clone();
            shipment
        }
        Err(errors) => {
            let bought = bought_of(&found, choice.buy.directions());
            return req
                .invalid(
                    &errors,
                    LabelForm {
                        number: &found.order.number,
                        input: &input,
                        buy: choice.buy,
                        bought: &bought,
                        mode,
                        errors: &errors,
                    },
                    || {
                        let draft = Draft {
                            input: &input,
                            buy: choice.buy,
                            errors: &errors,
                        };
                        labels_page(
                            &req,
                            &db,
                            &legacy,
                            visitor,
                            Some(&number),
                            None,
                            Some(draft),
                        )
                    },
                )
                .await;
        }
    };
    if !bought_of(&found, choice.buy.directions()).is_empty() && !choice.again {
        let why = "A label was already bought for this order. Confirm to buy another.";
        return refused(
            &req,
            &db,
            &legacy,
            visitor,
            &number,
            why,
            kept(&input, &choice),
        )
        .await;
    }
    for &direction in choice.buy.directions() {
        let item = Planned {
            shipment: shipment.toward(direction),
            orders: vec![found.order.number.clone()],
        };
        let size = item.shipment.options.label_size;
        let bill = postage::buy(
            &legacy,
            size,
            direction,
            Scope::Single,
            std::slice::from_ref(&item),
        )
        .await;
        let missed = match bill {
            Err(why) => Some(why),
            Ok(bill) => bill
                .results
                .into_iter()
                .find(|r| r.status != Status::Purchased)
                .map(|r| r.error.unwrap_or_else(|| "no label was bought".into())),
        };
        if let Some(why) = missed {
            let what = match direction {
                Direction::Outbound => "outbound",
                Direction::Return => "return",
            };
            let why = format!("Failed to buy {what} label: {why}");
            return refused(
                &req,
                &db,
                &legacy,
                visitor,
                &number,
                &why,
                kept(&input, &choice),
            )
            .await;
        }
    }
    req.redirect(&url::OrderLabels {
        order: Some(found.order.number),
    })
}

/// The form as it was sent, so a refused purchase keeps what the operator changed.
fn kept<'a>(input: &'a ShipmentInput, choice: &Choice) -> Option<Draft<'a>> {
    static NONE: std::sync::LazyLock<Errors> = std::sync::LazyLock::new(Errors::new);
    Some(Draft {
        input,
        buy: choice.buy,
        errors: &NONE,
    })
}

/// The panel with why a post was refused, as a conflict.
async fn refused(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    number: &str,
    why: &str,
    draft: Option<Draft<'_>>,
) -> HtmlResult {
    let mut page = labels_page(req, db, legacy, visitor, Some(number), Some(why), draft).await?;
    *page.status_mut() = StatusCode::CONFLICT;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_return_is_bought_after_its_outbound_label() {
        assert_eq!(
            LabelsToBuy::RoundTrip.directions(),
            [Direction::Outbound, Direction::Return]
        );
        assert_eq!(LabelsToBuy::ReturnOnly.directions(), [Direction::Return]);
    }

    #[test]
    fn the_form_is_read_as_a_shipment_and_a_choice() {
        let body = b"name=Ann&street1=1+Main&street2=&city=X&state=TX&zip=75001&reference=A\
            &service=Priority&length=6&width=4&height=1&weight=2&label_format=PDF&label_size=4x6\
            &buy=round-trip&shown_service=First&again=true";
        let choice: Choice = from_bytes(body).unwrap();
        assert_eq!(choice.buy, LabelsToBuy::RoundTrip);
        assert_eq!(choice.shown_service, Some(Service::First));
        assert!(choice.again);
        let input: ShipmentInput = from_bytes(body).unwrap();
        assert_eq!(input.service, Service::Priority);
    }
}
