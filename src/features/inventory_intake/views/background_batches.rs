use std::sync::LazyLock;

use corten::prelude::*;

use crate::{
    features::{
        batch_pricer::url::BatchPricer,
        inventory_intake::{
            page::RateInput,
            queue::{self, Batches, CostRate, Run, Workflow},
            url::{self, Selection},
        },
    },
    layout::{Notice, Tone},
    theme::*,
};

#[derive(Id)]
pub struct BackgroundBatchesId;
#[derive(Id)]
struct BatchesPanelId;
#[derive(Id)]
struct BatchesHeadingId;
/// A batch's rate form, `rate-{batch}`: a refused change marks its own fields.
#[derive(Id)]
struct RateFormId(i32);

/// No errors, for the batches whose rate was not refused.
static NONE: LazyLock<Errors> = LazyLock::new(Errors::new);

/// The batches queued from this screen, as a one-line status that opens the latest 25. The page
/// reads it again every few seconds (`ReadAgain` beside it), so it follows their pricing.
#[component(css)]
pub fn BackgroundBatches<'a>(
    selection: &'a Selection,
    batches: Result<&'a Batches, &'a str>,
    refused: Option<(i32, &'a Errors)>,
) -> impl Patch {
    let (status, attention) = match batches {
        Ok(b) => {
            let attention = b.runs.iter().filter(|r| r.needs_attention()).count();
            (
                queue::summary(&b.runs),
                attention > 0 || b.target.publication_paused,
            )
        }
        Err(_) => ("status unavailable".to_owned(), true),
    };
    html! {
        <div id={BackgroundBatchesId}>
            <button
                type="button"
                popovertarget={BatchesPanelId}
                class={attention.then_some(Attention)}
            >
                "Background batches: "<span>{status}</span>
            </button>
            <div
                id={BatchesPanelId}
                popover
                role="region"
                aria-labelledby={BatchesHeadingId}
                class={(panel(), Drawer)}
            >
                <header class={row(Space::_2)}>
                    <h2 id={BatchesHeadingId}>"Background batches"</h2>
                    <button
                        type="button"
                        popovertarget={BatchesPanelId}
                        popovertargetaction="hide"
                        aria-label="Close background batches"
                    >
                        "×"
                    </button>
                </header>
                <p class={muted()}>
                    "Keep adding inventory while queued batches run. Showing the latest 25 handoffs; counts below are SKUs. "
                    <a href={BatchPricer::newest()}>"Open Batch Pricer"</a>"."
                </p>
                match batches {
                    Err(message) => {
                        <Notice tone={Tone::Warning}>
                            {message}" Previously shown status may be out of date."
                        </Notice>
                    }
                    Ok(b) => {
                        if b.target.publication_paused {
                            <Notice tone={Tone::Warning}>
                                "Publication is paused or needs attention. Pricing can continue. "
                                <a href="/publication-configuration">
                                    "Review publication controls"
                                </a>
                                "."
                            </Notice>
                        }
                        if b.runs.is_empty() {
                            <p>"No background batches queued yet."</p>
                        }
                        <ol class={Runs}>
                            for run in &b.runs {
                                <RunItem
                                    run={run}
                                    selection={selection}
                                    errors={refused.filter(|(n, _)| *n == run.batch_number).map(|(_, e)| e)}
                                />
                            }
                        </ol>
                    }
                }
            </div>
        </div>
    }
}

/// A batch: its status, its counts and cost, and, while an estimate costs it, its rate to change.
#[component(css = BackgroundBatches)]
fn RunItem<'a>(run: &'a Run, selection: &'a Selection, errors: Option<&'a Errors>) -> impl Render {
    let errors = errors.unwrap_or(&NONE);
    let (f, e) = (
        RateInput::FIELDS,
        errors.within(RateFormId(run.batch_number)),
    );
    let rate = run.cost_rate.unwrap_or(CostRate::DEFAULT);
    html! {
        <li>
            <div class={row(Space::_2)}>
                <a href={BatchPricer::batch(run.batch_number)}>
                    "Batch "{run.batch_number}
                </a>
                <span class={Chip}>{run.status().word()}</span>
                <span class={muted()}>
                    match run.workflow {
                        Workflow::Publish => "Publish when ready",
                        Workflow::PriceOnly => "Pricing only",
                    }
                </span>
            </div>
            <p>
                {run.quantity}" units / "{run.item_count}" SKUs; "{run.published_count}
                " published; "
                {run.review_count}" need review"
            </p>
            <p class={muted()}>{run.cost()}</p>
            if !run.has_entered_cost {
                <details open={!errors.is_empty()}>
                    <summary>"Change rate"</summary>
                    <form
                        id={RateFormId(run.batch_number)}
                        method="post"
                        action={url::ChangeRate { batch: run.batch_number, selection: selection.clone() }}
                        data-patch
                        class={RateForm}
                    >
                        <p class={muted()}>
                            "The batch is re-estimated at the new rate. The earlier estimate stays in the batch's cost history, and pricing is not affected."
                        </p>
                        {errors.form_message()}
                        <label>
                            "Percent of market"
                            <input
                                name={f.market_percent}
                                value={rate.market_percent()}
                                inputmode="decimal"
                                required
                                {..e.aria(f.market_percent)}
                            >
                            {e.message(f.market_percent)}
                        </label>
                        <label>
                            "Less per card ($)"
                            <input
                                name={f.per_card_deduction}
                                value={rate.per_card_deduction()}
                                inputmode="decimal"
                                required
                                {..e.aria(f.per_card_deduction)}
                            >
                            {e.message(f.per_card_deduction)}
                        </label>
                        <button data-primary>"Save rate"</button>
                    </form>
                </details>
            }
            if let Some(error) = run.planning_error.as_deref().or(run.pricing_error.as_deref()) {
                <Notice tone={Tone::Warning}>{error}</Notice>
            }
        </li>
    }
}
