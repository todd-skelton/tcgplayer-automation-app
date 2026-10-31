use corten::prelude::*;

use super::batch_panel::{BatchFollow, BatchProblem};
use crate::{
    features::batch_pricer::{
        batches::Batch,
        page::{Chosen, CsvInput, SellerInput, Shown},
        url,
    },
    layout::{Notice, SubmitsOnChange, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The CSV form's id: a refused file's answer replaces it.
#[derive(Id)]
pub struct CsvFormId;
/// The seller form's id: a refused seller's answer replaces it.
#[derive(Id)]
pub struct SellerFormId;

/// The screen: a new batch from a CSV export or a seller, the batch picker, and the batch picked.
/// What a post did shows in the layout's toaster; why one was refused, above the batch.
#[component(css)]
pub fn PricerScreen<'a>(
    list: &'a [Batch],
    number: Option<i32>,
    shown: Option<Result<&'a Shown, &'a str>>,
    seller: &'a str,
    errors: &'a Errors,
    problem: Option<&'a str>,
    t: Msg,
    visitor: Visitor,
) -> impl Render {
    // A batch linked directly that is older than the newest 100 is still offered.
    let unlisted = number.filter(|n| !list.iter().any(|b| b.batch_number == *n));
    html! {
        <h1>"Inventory Batch Pricer"</h1>
        <section class={(panel(), mb_5())}>
            <h2>"New Batch"</h2>
            <p class={muted()}>
                "Freeze a CSV export or a seller's live inventory into a batch. Pricing uses the server configuration."
            </p>
            <div class={NewBatch}>
                <CsvForm errors={errors} />
                <SellerForm seller={seller} errors={errors} />
            </div>
        </section>
        <section class={(panel(), mb_5())}>
            <h2>"Select Inventory Batch"</h2>
            <p class={muted()}>
                "The newest 100 manual batches are shown here. Each is a frozen snapshot from Inventory Manager, a seller snapshot, or a CSV upload. Automatic run history is kept on Continuous Pricing, and a direct batch link remains available for older manual batches."
            </p>
            if list.is_empty() && unlisted.is_none() {
                <Notice tone={Tone::Info}>
                    "No inventory batches exist yet. Create one above or from the "
                    <a href="/inventory-manager">"Inventory Manager"</a>
                    "."
                </Notice>
            } else {
                <SubmitsOnChange>
                    <form method="get" action={url::BatchPricer::newest()} class={Picker}>
                        <label>
                            "Batch"
                            <select name={Chosen::FIELDS.batch}>
                                if let Some(n) = unlisted {
                                    <option value={n} selected>"Batch "{n}</option>
                                }
                                for batch in list {
                                    <option
                                        value={batch.batch_number}
                                        selected={Some(batch.batch_number) == number}
                                    >
                                        {choice(batch)}
                                    </option>
                                }
                            </select>
                        </label>
                        <noscript><button>"Show"</button></noscript>
                    </form>
                </SubmitsOnChange>
            }
        </section>
        <BatchProblem message={problem} />
        match shown {
            None => {}
            Some(Err(message)) => {
                <Notice tone={Tone::Warning}>"Failed to load batch: "{message}</Notice>
            }
            Some(Ok(shown)) => {
                <BatchFollow shown={shown} t={t} visitor={visitor} />
            }
        }
    }
}

/// A batch in the picker: `Batch 2733 - Inventory Manager - priced (66 SKUs)`.
fn choice(batch: &Batch) -> String {
    format!(
        "Batch {} - {} - {} ({} SKUs)",
        batch.batch_number,
        batch.source(),
        batch.status.word(),
        batch.item_count
    )
}

/// A CSV export to freeze into a batch. With JavaScript a refused file swaps in this form with
/// why; without, the whole page comes back.
#[component(css = PricerScreen)]
pub fn CsvForm<'a>(errors: &'a Errors) -> impl Patch {
    let (f, e) = (CsvInput::FIELDS, errors.within(CsvFormId));
    html! {
        <form
            id={CsvFormId}
            method="post"
            action={url::ImportCsv}
            enctype="multipart/form-data"
            data-patch
            class={Source}
        >
            <div class={row(Space::_2)}>
                <input
                    type="file"
                    name={f.file}
                    accept=".csv,text/csv"
                    aria-label="CSV file"
                    required
                    {..e.aria(f.file)}
                >
                <button data-primary>"Upload CSV"</button>
            </div>
            {e.message(f.file)}
        </form>
    }
}

/// A seller whose live inventory to freeze into a batch, the shipping settings' default seller
/// at first.
#[component(css = PricerScreen)]
pub fn SellerForm<'a>(seller: &'a str, errors: &'a Errors) -> impl Patch {
    let (f, e) = (SellerInput::FIELDS, errors.within(SellerFormId));
    html! {
        <form id={SellerFormId} method="post" action={url::ImportSeller} data-patch class={Source}>
            <div class={row(Space::_2)}>
                <label>
                    "Seller Key "
                    <input name={f.seller_key} value={seller} required {..e.aria(f.seller_key)}>
                </label>
                <button data-primary>"Snapshot Seller"</button>
            </div>
            {e.message(f.seller_key)}
        </form>
    }
}
