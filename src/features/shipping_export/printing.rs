//! The Print step's answers: the batch's packing slips, from TCGplayer, and one PDF of a label
//! size's labels made from the postage already bought.
use corten::{Media, PageOr, Refusal, prelude::*};

use super::{
    easypost::EasyPost,
    page::{Shown, hours_ahead, plan, refused},
    postage::{BatchLabel, BatchLabelStatus, Bought},
    purchase, sheet,
    steps::Step,
    url::{self, ShippingWorkflow},
    workflow,
};
use crate::{
    database::Database,
    features::shipping_configuration::{self, LabelSize},
};

/// The batch's packing slips as one PDF, in the order the shipments go: shown in the browser's
/// viewer (`?open=true`) or saved. When the Node app cannot make them, the Print step saying why.
/// Nothing keeps it, the browser's disk cache included: it carries the buyers' names and addresses.
pub async fn packing_slips(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::PackingSlips>,
) -> corten::Result<PageOr<Media>> {
    let open = at.open == Some(true);
    let (config, saved) = tokio::join!(
        shipping_configuration::settings(&db),
        workflow::current(&db)
    );
    let numbers = plan(&config?, saved?.as_ref()).order_numbers();
    if numbers.is_empty() {
        return Err(corten::Error::not_found());
    }
    let pdf = match sheet::packing_slips(&db, &numbers, hours_ahead(&req)).await {
        Ok(pdf) => pdf,
        Err(why) => {
            let why = format!("Failed to generate packing slips: {why}");
            let page = refused(&req, &db, Step::Print, Refusal::Upstream, &why).await?;
            return Ok(page.into());
        }
    };
    // The time it was made, as `toISOString` writes it with `:` and `.` made `-`.
    let made = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let name = format!("packing-slips-{made}.pdf");
    let media = Media::new("application/pdf", pdf);
    Ok(if open {
        media.inline(&name)
    } else {
        media.attachment(&name)
    }
    .into())
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
    Params(at): Params<url::BatchLabelPdf>,
) -> HtmlResult {
    let size = at.size;
    let shown = Shown::read(&db).await?;
    let labels = labels_of(&shown, size);
    let Some((_, first)) = labels.first() else {
        let why = format!("Buy {size} postage before creating its batch PDF.");
        return refused(&req, &db, Step::Print, Refusal::Conflict, &why).await;
    };
    let mode = first.mode;
    let label = if labels.iter().all(|(_, b)| b.mode == mode) {
        let ids: Vec<(&str, &str)> = labels
            .iter()
            .filter_map(|(reference, b)| {
                Some((*reference, b.result.easypost_shipment_id.as_deref()?))
            })
            .collect();
        match purchase::batch_label(&EasyPost::default(), mode, &ids).await {
            Ok(label) => label,
            Err(why) => {
                let why = format!("Failed to create the batch label PDF: {why}");
                return refused(&req, &db, Step::Print, Refusal::Upstream, &why).await;
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
