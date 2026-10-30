use corten::prelude::*;

use crate::{
    features::{
        shipping_configuration::LabelSize,
        shipping_export::{
            postage::{BatchLabel, BatchLabelStatus, Bought},
            url,
        },
    },
    theme::*,
};

/// One label size as the Print step shows it: its batch PDF, if one was made, and each label of
/// that size bought.
pub struct LabelSheet<'a> {
    pub size: LabelSize,
    pub batch: Option<&'a BatchLabel>,
    pub labels: Vec<(&'a str, &'a Bought)>,
}

impl LabelSheet<'_> {
    /// Its labels can go in one PDF: there are some, all bought in one mode.
    fn can_combine(&self) -> bool {
        self.labels
            .first()
            .is_some_and(|(_, first)| self.labels.iter().all(|(_, b)| b.mode == first.mode))
    }
}

/// The batch's packing slips, to open or save, and each label size's labels: one PDF of them,
/// or the way to make it, and each label on its own.
#[component(css)]
pub fn PrintStep<'a>(sheets: &'a [LabelSheet<'a>], has_orders: bool) -> impl Render {
    html! {
        <div class={PrintStep}>
            <section>
                <h2>"Packing Slips"</h2>
                <div class={row(Space::_2)}>
                    if has_orders {
                        <a
                            href={url::PackingSlips { open: Some(true) }}
                            target="_blank"
                            data-reload
                            class={Button}
                        >
                            "↗ Open Packing Slips PDF"
                        </a>
                        <a href={url::PackingSlips { open: None }} download class={Button}>
                            "⤓ Download Packing Slips PDF"
                        </a>
                    } else {
                        <button type="button" disabled>"↗ Open Packing Slips PDF"</button>
                        <button type="button" disabled>"⤓ Download Packing Slips PDF"</button>
                    }
                </div>
            </section>
            <section>
                <h2>"Postage Labels"</h2>
                if sheets.is_empty() {
                    <p class={muted()}>
                        "No postage purchased yet. Go back to Buy Postage to purchase labels."
                    </p>
                } else {
                    <div class={Sheets}>
                        for sheet in sheets { <SizeLabels sheet={sheet} /> }
                    </div>
                }
            </section>
        </div>
    }
}

#[component(css = PrintStep)]
fn SizeLabels<'a>(sheet: &'a LabelSheet<'a>) -> impl Render {
    let pdfs: Vec<(&str, &str)> = sheet
        .labels
        .iter()
        .filter_map(|(reference, b)| Some((*reference, b.result.label_pdf_url.as_deref()?)))
        .collect();
    let status = sheet.batch.map(|b| b.status);
    html! {
        <article class={Sheet}>
            <h3>{sheet.size}" Labels"</h3>
            if let Some(batch) = sheet.batch {
                match batch.status {
                    BatchLabelStatus::Ready => {
                        if let Some(href) = &batch.label_url {
                            <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                class={(Button, Primary)}
                            >
                                "↗ Open Batch Label PDF"
                            </a>
                        }
                        <span class={(Chip, Good)}>
                            {batch.shipment_references.len()}" labels in batch"
                        </span>
                    }
                    BatchLabelStatus::Pending => <p class={muted()}>
                        {batch.message.as_deref().unwrap_or("EasyPost is still generating the batch PDF.")}
                    </p>,
                    BatchLabelStatus::Failed => <p class={Bad}>
                        {batch.message.as_deref().unwrap_or("Failed to generate the batch PDF.")}
                    </p>,
                    BatchLabelStatus::Skipped => <p class={muted()}>
                        {batch.message.as_deref().unwrap_or("No batch PDF was made.")}
                    </p>,
                }
            }
            if status != Some(BatchLabelStatus::Ready) {
                if sheet.can_combine() {
                    <span class={(Chip, Info)}>{sheet.labels.len()}" saved labels"</span>
                    <form
                        method="post"
                        action={url::BatchLabelPdf { size: sheet.size }}
                        class={Act}
                    >
                        <button class={Button}>
                            if status.is_some() {
                                "Create Batch Label PDF Again"
                            } else {
                                "Create Batch Label PDF"
                            }
                        </button>
                    </form>
                } else if sheet.batch.is_none() {
                    <p class={muted()}>
                        if sheet.labels.is_empty() {
                            "Buy postage to generate a combined PDF."
                        } else {
                            "Saved labels span multiple EasyPost modes and cannot be combined."
                        }
                    </p>
                }
            }
            if !pdfs.is_empty() {
                <details>
                    <summary class={muted()}>"Individual labels ("{pdfs.len()}")"</summary>
                    <ul class={Individual}>
                        for (reference, href) in &pdfs {
                            <li>
                                <a href={*href} target="_blank" rel="noreferrer">
                                    {*reference}" Label PDF"
                                </a>
                            </li>
                        }
                    </ul>
                </details>
            }
        </article>
    }
}
