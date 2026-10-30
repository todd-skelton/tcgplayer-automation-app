//! The Print step's answers: the batch's packing slips, from TCGplayer, and one PDF of a label
//! size's labels made from the postage already bought.
use corten::{ClientZone, Media, axum::http::StatusCode, prelude::*};
use serde::Serialize;

use super::{
    page::{Shown, hours_ahead, plan, refused},
    postage::{self, BatchLabel, BatchLabelStatus, Bought},
    steps::Step,
    url::{self, ShippingWorkflow},
    workflow,
};
use crate::{
    database::Database,
    features::shipping_configuration::{self, LabelSize},
    legacy::Legacy,
    zone::Visitor,
};

/// The batch's packing slips as one PDF, in the order the shipments go: shown in the browser's
/// viewer (`?open=true`) or saved.
pub async fn packing_slips(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::PackingSlips>,
) -> corten::Result<Media> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        order_numbers: &'a [String],
        timezone_offset: f64,
    }
    let (config, saved) = tokio::join!(
        shipping_configuration::settings(&db),
        workflow::current(&db)
    );
    let numbers = plan(&config?, saved?.as_ref()).order_numbers();
    if numbers.is_empty() {
        return Err(corten::Error::not_found());
    }
    let request = Request {
        order_numbers: &numbers,
        timezone_offset: hours_ahead(Visitor::of(zone.as_ref())),
    };
    let pdf = legacy
        .send_for_file("/api/shipping-export/packing-slips-export", &request)
        .await
        .map_err(|why| {
            corten::Error::new(format!("Failed to generate packing slips: {why}"))
                .with_status(StatusCode::BAD_GATEWAY)
        })?;
    let name = pdf.file_name.unwrap_or_else(|| "packing-slips.pdf".into());
    let media = Media::new("application/pdf", pdf.bytes);
    Ok(if at.open == Some(true) {
        media.inline(&name)
    } else {
        media.attachment(&name)
    })
}

/// The labels of `size` that can go in one PDF: each shipment of that size with postage bought,
/// and its EasyPost shipment.
pub fn labels_of(shown: &Shown, size: LabelSize) -> Vec<(&str, &Bought)> {
    shown
        .batch
        .shipments
        .iter()
        .filter(|p| p.shipment.options.label_size == size)
        .filter_map(|p| {
            shown
                .outbound(p.reference())
                .filter(|b| b.purchased() && b.result.easypost_shipment_id.is_some())
                .map(|b| (p.reference(), b))
        })
        .collect()
}

/// One PDF of a label size's labels, made again from the postage bought: for labels bought one
/// at a time, or a batch PDF EasyPost had not finished. Labels bought in both modes cannot share
/// one, which the step then says.
pub async fn create_batch_label(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::BatchLabelPdf>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let size = at.size;
    let shown = Shown::read(&db, &legacy).await?;
    let labels = labels_of(&shown, size);
    let Some((_, first)) = labels.first() else {
        let why = format!("Buy {size} postage before creating its batch PDF.");
        return refused(&req, &db, &legacy, visitor, Step::Print, &why).await;
    };
    let mode = first.mode;
    let label = if labels.iter().all(|(_, b)| b.mode == mode) {
        let ids: Vec<(&str, &str)> = labels
            .iter()
            .filter_map(|(reference, b)| {
                Some((*reference, b.result.easypost_shipment_id.as_deref()?))
            })
            .collect();
        match postage::batch_label(&legacy, mode, size, &ids).await {
            Ok(label) => label,
            Err(why) => {
                let why = format!("Failed to create the batch label PDF: {why}");
                return refused(&req, &db, &legacy, visitor, Step::Print, &why).await;
            }
        }
    } else {
        BatchLabel {
            status: BatchLabelStatus::Failed,
            shipment_references: labels.iter().map(|(r, _)| (*r).to_owned()).collect(),
            batch_id: None,
            label_url: None,
            message: Some(
                "Saved labels for this size span multiple EasyPost modes. Rebuy or regroup them to generate one batch PDF."
                    .into(),
            ),
        }
    };
    workflow::change(&db, move |w| w.set_batch_label(size, label)).await?;
    req.redirect(&ShippingWorkflow::at(Step::Print))
}
