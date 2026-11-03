use corten::{form::keep_query, prelude::*};

use crate::{
    features::shipping_export::{
        page::{At, HistoryInput, LoadInput},
        source::Coverage,
        steps::Step,
        url,
    },
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        field::Field,
        input::Input,
        popover::Popover,
        separator::{Orientation, Separator},
    },
};

// The seller form is a link with a query: it has no field errors, so its field is named from its
// id through Within::none.
#[derive(Id)]
struct LoadOrdersSellerFormId;

#[derive(Id)]
struct SellerPopoverId;
#[derive(Id)]
struct OrderHistoryPopoverId;

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
    let here = url::ShippingWorkflow::at(Step::LoadOrders);
    html! {
        <div class={LoadOrdersStep}>
            if !loading.warnings.is_empty() {
                <Alert variant={AlertVariant::Warning}>
                    <strong>"Order load warnings"</strong>
                    for warning in loading.warnings { <p>{warning}</p> }
                </Alert>
            }
            <div class={Actions}>
                <form method="post" action={url::LoadOrders} data-patch>
                    <input type="hidden" name={l.seller_key} value={seller}>
                    <button
                        class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                    >
                        "Load Live TCGPlayer Orders"
                    </button>
                </form>
                <button
                    type="button"
                    popovertarget={SellerPopoverId}
                    class={(
                        Button { variant: ButtonVariant::Link, size: ButtonSize::Md },
                        seller.is_empty().then_some(Unset),
                    )}
                >
                    "Seller: "
                    if seller.is_empty() { "not set" } else { {seller} }
                </button>
                <div popover id={SellerPopoverId} class={(Popover {}, Seller)}>
                    let e = Within::none(LoadOrdersSellerFormId);
                    <form id={LoadOrdersSellerFormId} method="get" action={&here}>
                        {keep_query(&here, html! {
                            <Field id={e.id(q.seller)} label="Seller Key" hint={&hint} error="">
                                <input class={Input {}}
                                    value={seller}
                                    placeholder={if loading.configured.is_empty() { "Enter seller key" } else { loading.configured }}
                                    autofocus
                                    {..e.control(q.seller).hint()}
                                >
                            </Field>
                            <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>"Use This Seller"</button>
                        })}
                    </form>
                </div>
                <Separator orientation={Orientation::Vertical} />
                <form method="post" action={url::LoadOrder} class={row(Space::_2)} data-patch>
                    <input type="hidden" name={l.seller_key} value={seller}>
                    <input
                        class={Input {}}
                        name={l.order_number}
                        aria-label="Order Number"
                        placeholder="Order Number"
                        required
                    >
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Lookup Single Order"
                    </button>
                </form>
                // Two forms, one with a file, not a list of commands: the kit's Popover, not its menu.
                <button
                    type="button"
                    popovertarget={OrderHistoryPopoverId}
                    class={(Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }, History)}
                >
                    "Order History"
                </button>
                <div popover id={OrderHistoryPopoverId} class={(Popover {}, HistoryForms)}>
                    <form method="post" action={url::OrderHistory} data-patch>
                        <input type="hidden" name={h.seller_key} value={seller}>
                        <button
                            class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }}
                        >
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
                        data-patch
                    >
                        <input type="hidden" name={h.seller_key} value={seller}>
                        <label>
                            <strong>"Import Older Order CSV"</strong>
                            <small>
                                "A USD order export for orders older than the three-month API window."
                            </small>
                            <input type="file" name={h.file} accept=".csv,text/csv" required>
                        </label>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Import"
                        </button>
                    </form>
                </div>
            </div>
            if let Some((source, count)) = loading.source {
                <p class={row(Space::_2)}>
                    <span
                        class={Badge { tone: BadgeTone::Primary, emphasis: BadgeEmphasis::Solid }}
                    >
                        {source}
                    </span>
                    <span
                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                    >
                        {count}" orders loaded"
                    </span>
                </p>
            }
            match &loading.coverage {
                Some(Ok(coverage)) if coverage.error.is_some() => {
                    <Alert variant={AlertVariant::Warning}>{coverage.describe()}</Alert>
                }
                Some(Err(why)) => <Alert variant={AlertVariant::Warning}>
                    "Seller order history status is unavailable: "{why}
                </Alert>,
                _ => {}
            }
        </div>
    }
}
