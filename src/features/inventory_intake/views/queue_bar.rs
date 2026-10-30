use corten::prelude::*;
use corten_ui::RequiredWhen;

use crate::{
    features::inventory_intake::{
        page::ClearInput,
        pending::Totals,
        queue::{CostMethod, CostRate, QueueInput, Target, Workflow},
        url::{self, Selection},
    },
    theme::*,
};

#[derive(Id)]
pub struct QueueTotalsId;
#[derive(Id)]
pub struct QueueFormId;
#[derive(Id)]
pub struct ClearConfirmId;
#[derive(Id)]
struct CostHeadingId;
#[derive(Id)]
struct PublishNoteId;

/// The bar at the foot of the screen: what is counted and not queued, the cost of the next
/// batch, and the buttons that queue or clear it. Its form shows only while something is counted.
#[component(css)]
pub fn QueueBar<'a>(
    selection: &'a Selection,
    totals: Totals,
    counted: &'a str,
    input: &'a QueueInput,
    target: Option<&'a Target>,
    errors: &'a Errors,
) -> impl Render {
    html! {
        <section class={(panel(), QueueBar)} aria-label="Unqueued inventory">
            <QueueTotals totals={totals} counted={counted} />
            <QueueForm selection={selection} input={input} target={target} errors={errors} />
            <ClearConfirm selection={selection} totals={totals} />
        </section>
    }
}

/// The units and SKUs counted and not queued, and the counts' fingerprint, which the queue form
/// sends so counts it did not show are not queued. Every count's answer replaces it.
#[component(css = QueueBar)]
pub fn QueueTotals<'a>(totals: Totals, counted: &'a str) -> impl Patch {
    html! {
        <div id={QueueTotalsId} class={row(Space::_2)} role="status">
            <input
                type="hidden"
                form={QueueFormId}
                name={QueueInput::FIELDS.counted}
                value={counted}
            >
            if totals.units > 0 {
                <strong class={Units}>
                    {totals.units}" unqueued units across "{totals.skus}" SKUs"
                </strong>
                <button type="button" popovertarget={ClearConfirmId}>"Clear unqueued"</button>
            } else {
                <span class={(muted(), NothingCounted)}>"Nothing counted yet"</span>
            }
        </div>
    }
}

/// Asks before clearing what is not queued; batches already queued keep theirs.
#[component(css = QueueBar)]
pub fn ClearConfirm<'a>(selection: &'a Selection, totals: Totals) -> impl Patch {
    html! {
        <div id={ClearConfirmId} popover class={(panel(), Confirm)}>
            <h2>"Clear unqueued inventory?"</h2>
            <p>
                "This removes "{totals.units}" units across "{totals.skus}
                " SKUs that have not been queued yet. Batches that have already been queued are not affected."
            </p>
            <form
                method="post"
                action={url::ClearCounts { selection: selection.clone() }}
                data-patch
                class={row(Space::_2)}
            >
                {SubmitKey::field(ClearInput::FIELDS.submit)}
                <button type="button" popovertarget={ClearConfirmId} popovertargetaction="hide">
                    "Cancel"
                </button>
                <button class={Danger}>"Clear unqueued"</button>
            </form>
        </div>
    }
}

/// What publishing queues for, in the words of the React screen's menu.
fn publish_note(target: Option<&Target>) -> String {
    match target {
        None => "Publishing is not available right now.".to_owned(),
        Some(t) if !t.can_publish => t
            .publishing_unavailable_reason
            .clone()
            .unwrap_or_else(|| "Publishing is not available right now.".to_owned()),
        Some(t) if t.publication_paused => {
            "Publication is paused or needs attention. Pricing continues; results wait until publication resumes."
                .to_owned()
        }
        Some(t) => format!(
            "Eligible results go live for seller {}, subject to publication safety controls.",
            t.seller_key
        ),
    }
}

/// The cost of the next batch and the two ways to queue it. Without the seller (the Node app did
/// not answer) nothing can be queued; without a seller that publishes, only pricing can.
#[component(css = QueueBar)]
pub fn QueueForm<'a>(
    selection: &'a Selection,
    input: &'a QueueInput,
    target: Option<&'a Target>,
    errors: &'a Errors,
) -> impl Patch {
    let (f, e) = (QueueInput::FIELDS, errors.within(QueueFormId));
    let method = input.cost;
    let rate = format!("Default estimate: {}", CostRate::DEFAULT.describe());
    let can_queue = target.is_some();
    let can_publish = target.is_some_and(|t| t.can_publish);
    let seller = target.map_or("", |t| t.seller_key.as_str());
    html! {
        <form
            id={QueueFormId}
            method="post"
            action={url::QueueBatch { selection: selection.clone() }}
            data-patch
            class={QueueForm}
        >
            {SubmitKey::field(f.request)}
            <input type="hidden" name={f.seller} value={seller}>
            <details class={Cost}>
                <summary>
                    "Cost: "
                    <span class={ByEstimate}>{&rate}</span>
                    <span class={ByRate}>"my rate"</span>
                    <span class={ByPurchase}>"purchase total"</span>
                </summary>
                <fieldset class={CostFields} aria-labelledby={CostHeadingId}>
                    <h2 id={CostHeadingId}>"Cost of the next batch"</h2>
                    for (value, text) in [(CostMethod::Estimate, rate.as_str()), (CostMethod::CostRate, "My own rate"), (CostMethod::PurchaseTotal, "Purchase total")] {
                        <label class={Choice}>
                            <input
                                type="radio"
                                name={f.cost}
                                value={value}
                                checked={value == method}
                            >
                            {text}
                        </label>
                    }
                    <RequiredWhen control={f.cost} values={&[CostMethod::CostRate]}>
                        <div class={(RateFields, row(Space::_3))}>
                            <label>
                                "Percent of market"
                                <input
                                    name={f.market_percent}
                                    value={&input.market_percent}
                                    inputmode="decimal"
                                    pattern="\\d+(\\.\\d{1,2})?"
                                    {..e.aria(f.market_percent)}
                                >
                                {e.message(f.market_percent)}
                            </label>
                            <label>
                                "Less per card ($)"
                                <input
                                    name={f.per_card_deduction}
                                    value={&input.per_card_deduction}
                                    inputmode="decimal"
                                    pattern="\\d+(\\.\\d{1,2})?"
                                    {..e.aria(f.per_card_deduction)}
                                >
                                {e.message(f.per_card_deduction)}
                            </label>
                            <p class={muted()}>
                                "The rate stays selected for later batches of this lot until you change it. It also costs cards whose market price is found after intake, and you can change a queued batch's rate in Background batches."
                            </p>
                        </div>
                    </RequiredWhen>
                    <RequiredWhen control={f.cost} values={&[CostMethod::PurchaseTotal]}>
                        <div class={(PurchaseFields, row(Space::_3))}>
                            <label>
                                "Purchase reference"
                                <input
                                    name={f.purchase_reference}
                                    value={&input.purchase_reference}
                                    {..e.aria(f.purchase_reference)}
                                >
                                {e.message(f.purchase_reference)}
                            </label>
                            <label>
                                "Purchase total (USD)"
                                <input
                                    name={f.purchase_total}
                                    value={&input.purchase_total}
                                    inputmode="decimal"
                                    {..e.aria(f.purchase_total)}
                                >
                                {e.message(f.purchase_total)}
                            </label>
                        </div>
                    </RequiredWhen>
                    <div class={(PurchaseFields, row(Space::_3))}>
                        <label>
                            "Purchase date"
                            <input type="date" name={f.purchase_date} value={&input.purchase_date}>
                        </label>
                        <label class={Choice}>
                            <input
                                type="checkbox"
                                name={f.purchase_estimated}
                                value="true"
                                checked={input.purchase_estimated}
                            >
                            "Estimated"
                        </label>
                        <p class={muted()}>
                            "Enter only this handoff's share if the purchase is split across batches. It is split across the cards by quantity and clears after the batch is queued."
                        </p>
                    </div>
                    <p class={muted()}>
                        "Cost feeds margins and Inventory Economics; pricing does not use it. Estimates use each card's market price at intake, so a card worth less than the amount per card counts as negative cost."
                    </p>
                </fieldset>
            </details>
            <div class={Problem} role="status">
                {errors.form_message()}
                if !can_queue {
                    "Waiting for batch status before queuing."
                }
            </div>
            <div class={row(Space::_2)}>
                <button
                    data-primary
                    name={f.workflow}
                    value={Workflow::PriceOnly}
                    disabled={!can_queue}
                >
                    "Queue pricing only"
                </button>
                <button
                    name={f.workflow}
                    value={Workflow::Publish}
                    disabled={!can_publish}
                    aria-describedby={PublishNoteId}
                >
                    "Queue pricing & publishing"
                </button>
            </div>
            <p id={PublishNoteId} class={(muted(), PublishNote)}>
                {publish_note(target)}
                if target.is_some_and(|t| !t.can_publish) {
                    " "<a href="/publication-configuration">"Publication settings"</a>"."
                }
            </p>
        </form>
    }
}
