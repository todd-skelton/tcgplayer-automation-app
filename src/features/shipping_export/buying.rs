//! The Buy Postage step's posts: postage for every shipment or one, a return label, a shipment
//! edited by hand, and a shipment as EasyPost's CSV.
use chrono::Utc;
use corten::{ClientZone, Media, prelude::*};
use serde::Deserialize;

use super::{
    editing::ShipmentInput,
    page::{Shown, page, plan, refused},
    postage::{self, Scope, Status},
    shipments::{self, Batch, Direction, Planned},
    steps::Step,
    url::{self, ShippingWorkflow},
    views::ShipmentEditorForm,
    workflow,
};
use crate::{
    database::Database,
    features::shipping_configuration::{self, EasyPostMode},
    legacy::Legacy,
    zone::Visitor,
};

/// Why postage cannot be bought now: another purchase is running, or the mode has no key.
pub(super) fn cannot_buy(mode: EasyPostMode) -> Option<String> {
    (!mode.has_key()).then(|| {
        format!(
            "{} is not set. Postage purchase is disabled.",
            mode.key_name()
        )
    })
}

const BUYING: &str = "Postage is already being bought. Try again when that purchase finishes.";

/// Postage for every shipment, a label size at a time, as the React screen's Buy All Postage
/// bought it: each size in one purchase, with one PDF of its labels for the Print step. A
/// shipment that already has postage is skipped by the Node app. A purchase that fails stops the
/// rest.
pub async fn buy_all(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let mode = EasyPostMode::of_deployment();
    let Some(_buying) = postage::BUYING.start() else {
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, BUYING).await;
    };
    if let Some(why) = cannot_buy(mode) {
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    }
    let (config, saved) = tokio::join!(
        shipping_configuration::settings(&db),
        workflow::current(&db)
    );
    let batch = plan(&config?, saved?.as_ref());
    if batch.shipments.is_empty() {
        let why = "Load orders before buying postage.";
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, why).await;
    }
    for size in batch.label_sizes() {
        let of_size: Vec<Planned> = batch
            .shipments
            .iter()
            .filter(|p| p.shipment.options.label_size == size)
            .cloned()
            .collect();
        match postage::buy(&legacy, size, Direction::Outbound, Scope::Bulk, &of_size).await {
            Ok(bill) => {
                workflow::change(&db, move |w| {
                    w.attempted(bill.mode, bill.results);
                    w.set_batch_label(size, bill.batch_label);
                })
                .await?;
            }
            Err(why) => {
                let why = format!("Failed to buy {size} postage: {why}");
                return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
            }
        }
    }
    req.redirect(&ShippingWorkflow::at(Step::BuyPostage))
}

#[derive(Deserialize, Fields)]
pub struct BuyInput {
    #[serde(default)]
    pub direction: Direction,
    /// Set once the operator said to buy a second label.
    #[serde(default)]
    pub again: bool,
}

/// Postage, or a return label, for one shipment. A second label in the same mode is bought only
/// when the operator said so (`again`), since the first is not refunded.
pub async fn buy_shipment(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::BuyShipmentPostage>,
    Form(input): Form<BuyInput>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let mode = EasyPostMode::of_deployment();
    let reference = at.reference;
    let direction = input.direction;
    let Some(_buying) = postage::BUYING.start() else {
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, BUYING).await;
    };
    if let Some(why) = cannot_buy(mode) {
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    }
    let shown = Shown::read(&db, &legacy).await?;
    let Some(planned) = shown.batch.shipment(&reference) else {
        let why = format!("Shipment {reference} is not in this batch.");
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    };
    let (what, bought) = match direction {
        Direction::Outbound => ("Postage", shown.outbound(&reference)),
        Direction::Return => ("A return label", shown.returned(&reference)),
    };
    if bought.is_some_and(|b| b.bought_in(mode)) && !input.again {
        let why = format!(
            "{what} was already bought for shipment {reference} in {} mode. Confirm to buy another.",
            mode.name()
        );
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    }
    let item = Planned {
        shipment: planned.shipment.toward(direction),
        orders: planned.orders.clone(),
    };
    let size = item.shipment.options.label_size;
    let bill = match postage::buy(
        &legacy,
        size,
        direction,
        Scope::Single,
        std::slice::from_ref(&item),
    )
    .await
    {
        Ok(bill) => bill,
        Err(why) => {
            let why = format!("Failed to buy postage: {why}");
            return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
        }
    };
    let missed = bill
        .results
        .iter()
        .find(|r| r.status != Status::Purchased)
        .map(|r| {
            r.error
                .clone()
                .unwrap_or_else(|| "no label was bought".into())
        });
    workflow::change(&db, move |w| match direction {
        Direction::Outbound => w.attempted(bill.mode, bill.results),
        Direction::Return => postage::merge(&mut w.returns, bill.mode, bill.results),
    })
    .await?;
    if let Some(why) = missed {
        let what = match direction {
            Direction::Outbound => "Postage",
            Direction::Return => "The return label",
        };
        let why = format!("{what} for shipment {reference} was not bought: {why}");
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    }
    req.redirect(&ShippingWorkflow::at(Step::BuyPostage))
}

/// A shipment, or its return, as the CSV EasyPost imports.
pub async fn shipment_csv(
    State(db): State<Database>,
    Params(at): Params<url::ShipmentCsv>,
) -> corten::Result<Media> {
    let (config, saved) = tokio::join!(
        shipping_configuration::settings(&db),
        workflow::current(&db)
    );
    let batch = plan(&config?, saved?.as_ref());
    let Some(planned) = batch.shipment(&at.reference) else {
        return Err(corten::Error::not_found());
    };
    let direction = at.direction.unwrap_or_default();
    let shipment = planned.shipment.toward(direction);
    let name = shipments::csv_file_name(&shipment, direction, Utc::now());
    Ok(Media::new("text/csv; charset=utf-8", shipments::csv(&[shipment])).attachment(&name))
}

/// The shipment as edited, kept for the batch in place of the one planned; one edited back to
/// the plan is no longer an edit.
pub async fn edit_shipment(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::EditShipment>,
    Form(input): Form<ShipmentInput>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let reference = at.reference;
    let (config, saved) = tokio::join!(
        shipping_configuration::settings(&db),
        workflow::current(&db)
    );
    let (config, saved) = (config?, saved?);
    let orders = saved.as_ref().map_or_else(Vec::new, |w| w.orders.clone());
    let edits = saved.map(|w| w.edits).unwrap_or_default();
    // Edits are kept by the reference planned, which an edit may have changed.
    let planned = Batch::plan(orders, &config);
    let shown: Vec<(&str, &shipments::Shipment)> = planned
        .shipments
        .iter()
        .map(|p| {
            (
                p.reference(),
                edits.get(p.reference()).unwrap_or(&p.shipment),
            )
        })
        .collect();
    let Some(&(original, current)) = shown.iter().find(|(_, s)| s.reference == reference) else {
        let why = format!("Shipment {reference} is not in this batch.");
        return refused(&req, &db, &legacy, visitor, Step::BuyPostage, &why).await;
    };
    let taken = |r: &str| shown.iter().any(|(_, s)| s.reference == r);
    match input.read(current, taken) {
        Ok(edited) => {
            let original = original.to_owned();
            let as_planned = planned.shipment(&original).map(|p| p.shipment.clone());
            workflow::change(&db, move |w| {
                if as_planned.as_ref() == Some(&edited) {
                    w.edits.remove(&original);
                } else {
                    w.edits.insert(original, edited);
                }
            })
            .await?;
            req.redirect(&ShippingWorkflow::at(Step::BuyPostage))
        }
        Err(errors) => {
            let editing = ShippingWorkflow::editing(&reference);
            req.invalid(
                &errors,
                ShipmentEditorForm {
                    reference: &reference,
                    input: &input,
                    errors: &errors,
                },
                || {
                    page(
                        &req,
                        &db,
                        &legacy,
                        visitor,
                        &editing,
                        None,
                        Some((&input, &errors)),
                    )
                },
            )
            .await
        }
    }
}
