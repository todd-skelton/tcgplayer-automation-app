use corten::prelude::*;

use crate::{
    features::shipping_export::{
        page::{At, HistoryInput, LoadInput},
        source::Coverage,
        steps::Step,
        url,
    },
    layout::{Field, Notice, Tone},
    theme::*,
};

#[derive(Id)]
struct SellerPopoverId;

/// What the Load Orders step shows.
pub struct Loading<'a> {
    /// The seller the loads are for: the page's `?seller=`, the batch's, or the settings'.
    pub seller: &'a str,
    /// The shipping settings' seller.
    pub configured: &'a str,
    /// Where the batch's orders came from, and how many there are.
    pub source: Option<(&'a str, usize)>,
    pub warnings: &'a [String],
    /// How far the seller's order history scan has got, or why it could not be read.
    pub coverage: Option<Result<Coverage, String>>,
}

/// Loads the Ready to Ship queue or one order. The seller is a choice of the page (a GET form in a
/// popover), so both loads carry it; the order history's catch-up and import are in a menu.
#[component(css)]
pub fn LoadOrdersStep<'a>(loading: &'a Loading<'a>) -> impl Render {
    let (l, h, q) = (LoadInput::FIELDS, HistoryInput::FIELDS, At::FIELDS);
    let seller = loading.seller.trim();
    let hint = if loading.configured.is_empty() {
        "Save a default seller key in Shipping Configuration or enter one here.".to_owned()
    } else {
        format!(
            "Saved default: {}. Used for loading, lookups, and returns.",
            loading.configured
        )
    };
    html! {
        <div class={LoadOrdersStep}>
            if !loading.warnings.is_empty() {
                <Notice tone={Tone::Warning}>
                    <strong>"Order load warnings"</strong>
                    for warning in loading.warnings { <p>{warning}</p> }
                </Notice>
            }
            <div class={Actions}>
                <form method="post" action={url::LoadOrders}>
                    <input type="hidden" name={l.seller_key} value={seller}>
                    <button class={Primary}>"Load Live TCGPlayer Orders"</button>
                </form>
                <button
                    type="button"
                    popovertarget={SellerPopoverId}
                    class={(SellerButton, seller.is_empty().then_some(Unset))}
                >
                    "Seller: "
                    if seller.is_empty() { "not set" } else { {seller} }
                </button>
                <div popover id={SellerPopoverId} class={Popover}>
                    <form method="get" action={url::ShippingWorkflow::at(Step::LoadOrders)}>
                        <input type="hidden" name={q.step} value={Step::LoadOrders}>
                        <Field label="Seller Key" hint={&hint}>
                            <input
                                name={q.seller}
                                value={seller}
                                placeholder={if loading.configured.is_empty() { "Enter seller key" } else { loading.configured }}
                                autofocus
                            >
                        </Field>
                        <button>"Use This Seller"</button>
                    </form>
                </div>
                <span class={Divider}></span>
                <form method="post" action={url::LoadOrder} class={row(Space::_2)}>
                    <input type="hidden" name={l.seller_key} value={seller}>
                    <input
                        name={l.order_number}
                        aria-label="Order Number"
                        placeholder="Order Number"
                        required
                    >
                    <button>"Lookup Single Order"</button>
                </form>
                <details class={Menu}>
                    <summary>"Order History"</summary>
                    <div class={MenuItems}>
                        <form method="post" action={url::OrderHistory}>
                            <input type="hidden" name={h.seller_key} value={seller}>
                            <button>
                                <strong>"Catch Up Order History"</strong>
                                <small>
                                    match &loading.coverage {
                                        Some(Ok(coverage)) => { {coverage.describe()} }
                                        _ => "Advances a saved scan of TCGPlayer's last three months, so orders stay on record after they ship.",
                                    }
                                </small>
                            </button>
                        </form>
                        <form
                            method="post"
                            action={url::ImportHistory}
                            enctype="multipart/form-data"
                        >
                            <input type="hidden" name={h.seller_key} value={seller}>
                            <label>
                                <strong>"Import Older Order CSV"</strong>
                                <small>
                                    "A USD order export for orders older than the three-month API window."
                                </small>
                                <input type="file" name={h.file} accept=".csv,text/csv" required>
                            </label>
                            <button>"Import"</button>
                        </form>
                    </div>
                </details>
            </div>
            if let Some((source, count)) = loading.source {
                <p class={row(Space::_2)}>
                    <span class={(Chip, Accent)}>{source}</span>
                    <span class={Chip}>{count}" orders loaded"</span>
                </p>
            }
            match &loading.coverage {
                Some(Ok(coverage)) if coverage.error.is_some() => {
                    <Notice tone={Tone::Warning}>{coverage.describe()}</Notice>
                }
                Some(Err(why)) => <Notice tone={Tone::Warning}>
                    "Seller order history status is unavailable: "{why}
                </Notice>,
                _ => {}
            }
        </div>
    }
}
