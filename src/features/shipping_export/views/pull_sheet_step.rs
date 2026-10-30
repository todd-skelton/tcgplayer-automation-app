use std::collections::HashMap;

use corten::{Href, prelude::*};

use super::SaleValueFigures;
use crate::{
    features::{
        pull_sheet::{Item, Paging, SheetItems, SortBy, Summary, url::SheetQuery},
        shipping_export::{
            shipments::{Batch, PackageType},
            steps::Step,
            url::ShippingWorkflow,
            value::SaleValue,
        },
    },
    layout::{Notice, Tone},
    text::Msg,
    theme::*,
};

/// The batch's pull sheet, as TCGplayer makes it for the orders, read with the catalog.
pub struct Pulled {
    pub items: Vec<Item>,
    pub summary: Summary,
    /// What each card sold for in the batch, by SKU.
    pub values: HashMap<i64, SaleValue>,
}

/// Every card to pull for the batch, as the Pull Sheet screen shows a sheet, each with what it
/// sold for; the packages the batch goes out as are counted beside them.
#[component]
pub fn PullSheetStep<'a>(
    pulled: &'a Result<Pulled, String>,
    batch: &'a Batch,
    filters: &'a SheetQuery,
    t: Msg,
) -> impl Render {
    let packages: Vec<String> = [
        (PackageType::Letter, "Letter"),
        (PackageType::Flat, "Flat"),
        (PackageType::Parcel, "Parcel"),
    ]
    .into_iter()
    .map(|(kind, name)| {
        let n = batch
            .shipments
            .iter()
            .filter(|p| p.shipment.parcel.predefined_package == kind)
            .count();
        (n, name)
    })
    .filter(|(n, _)| *n > 0)
    .map(|(n, name)| format!("{n} {name}"))
    .collect();
    let has_lines = batch.orders.iter().any(|o| !o.lines().is_empty());
    let at = move |sort: Option<SortBy>| {
        ShippingWorkflow {
            step: Some(Step::PullSheet),
            seller: None,
            filters: SheetQuery {
                q: sort.and(filters.q.clone()),
                sort,
            },
        }
        .with_href(str::to_owned)
    };
    html! {
        if !has_lines && !batch.orders.is_empty() {
            <Notice tone={Tone::Info}>
                "These orders did not include line items, so this step shows the TCGPlayer pull sheet as it was made rather than a list assembled here."
            </Notice>
        }
        match pulled {
            Err(why) => <Notice tone={Tone::Warning}>{why}</Notice>,
            Ok(pulled) if pulled.items.is_empty() => {
                <Notice tone={Tone::Info}>
                    "No pull sheet rows were generated for the current orders. Packing slips are available on Print."
                </Notice>
            }
            Ok(pulled) => {
                let link = |by| at(Some(by));
                let paging = Paging {
                    action: at(None),
                    keep: vec![("step", "pull-sheet".to_owned())],
                    filters,
                    link: &link,
                };
                let detail = |item: &Item, on_image: bool| -> Box<dyn Render + '_> {
                    match item.sku_id.and_then(|sku| pulled.values.get(&sku)) {
                        Some(value) => Box::new(SaleValueFigures { value, on_image, t }),
                        None => Box::new(""),
                    }
                };
                <SheetItems
                    items={&pulled.items}
                    summary={&pulled.summary}
                    lead={&html! {
                        if !packages.is_empty() {
                            <span class={muted()}>{packages.join(" · ")}</span>
                        }
                    }}
                    paging={&paging}
                    detail={Some(&detail)}
                    t={t}
                />
            }
        }
    }
}
