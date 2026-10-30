use corten::prelude::*;

use crate::{
    features::{
        shipping_configuration::{self, EasyPostMode},
        shipping_export::{
            steps::{Progress, Step},
            url::{OrderLabels, ShippingWorkflow},
        },
    },
    layout::{Notice, Tone},
    theme::*,
};

#[derive(Id)]
struct NewBatchDialogId;
#[derive(Id)]
struct NewBatchHeadingId;

/// What postage the deployment buys and whether it can: production with its key says nothing.
pub fn mode_warning(mode: EasyPostMode) -> Option<String> {
    if !mode.has_key() {
        Some(format!(
            "Missing {} API key",
            match mode {
                EasyPostMode::Test => "test",
                EasyPostMode::Production => "production",
            }
        ))
    } else if mode == EasyPostMode::Test {
        Some("Test mode".into())
    } else {
        None
    }
}

/// The workflow's frame: the steps as links, the postage mode, what went wrong, the step, and the
/// bar under it with where the step stands and the way on.
#[component(css)]
pub fn ShippingWorkflowScreen<'a>(
    step: Step,
    mode: EasyPostMode,
    problem: Option<&'a str>,
    bar: &'a dyn Render,
    children: impl Render,
) -> impl Render {
    html! {
        <div class={ShippingWorkflowScreen}>
            <header class={Header}>
                <h1>"Shipping Workflow"</h1>
                <nav aria-label="Steps" class={Stepper}>
                    <ol>
                        for (i, each) in Step::ALL.into_iter().enumerate() {
                            <li class={each.before(step).then_some(Done)}>
                                <a
                                    href={ShippingWorkflow::at(each)}
                                    aria-current={(each == step).then_some("step")}
                                >
                                    <span class={Number}>{i + 1}</span>
                                    {each.label()}
                                </a>
                            </li>
                        }
                    </ol>
                </nav>
                if let Some(warning) = mode_warning(mode) {
                    <span class={ModeChip}>{warning}</span>
                }
                <a href={OrderLabels { order: None }} class={Button}>"Label Management"</a>
                <a
                    href={shipping_configuration::url::ShippingSettings { done: None }}
                    aria-label="Shipping configuration"
                    title="Shipping configuration"
                    class={Settings}
                >
                    "⚙"
                </a>
            </header>
            if let Some(problem) = problem {
                <Notice tone={Tone::Warning}>{problem}</Notice>
            }
            <section aria-label={step.label()} class={(panel(), StepPanel)}>{children}</section>
            {bar}
        </div>
    }
}

/// Where the step stands, the value of what it works on, its one action, and the way to the next
/// step. Continue waits while the step is not ready; a step that may be left early offers to skip
/// in a menu. The last step starts a new batch, confirmed first when orders are not yet shipped.
#[component(css = ShippingWorkflowScreen)]
pub fn StepBar<'a>(
    step: Step,
    progress: &'a Progress,
    value: &'a dyn Render,
    action: &'a dyn Render,
    /// Set when starting over would drop orders not yet marked shipped.
    unshipped_warning: Option<&'a str>,
) -> impl Render {
    html! {
        <section aria-label="Current step" class={StepBar}>
            <p role="status" class={Summary}>{&progress.summary}</p>
            <div class={Value}>{value}</div>
            {action}
            if let Some(back) = step.previous() {
                <a href={ShippingWorkflow::at(back)} class={Button}>"Back"</a>
            }
            match step.next() {
                None => {
                    if unshipped_warning.is_some() {
                        <button
                            type="button"
                            command="show-modal"
                            commandfor={NewBatchDialogId}
                            class={(Button, Go)}
                        >
                            "Start New Batch"
                        </button>
                    } else {
                        <form method="post" action={super::super::url::NewBatch}>
                            <button class={(Button, Go)}>"Start New Batch"</button>
                        </form>
                    }
                }
                Some(next) => {
                    if progress.ready {
                        <a href={ShippingWorkflow::at(next)} class={(Button, Primary)}>
                            "Continue to "{next.label()}
                        </a>
                    } else {
                        <span class={Split}>
                            <button type="button" disabled class={(Button, Primary)}>
                                "Continue to "{next.label()}
                            </button>
                            if progress.can_skip {
                                <details class={Skip}>
                                    <summary
                                        aria-label="More ways to continue"
                                        class={(Button, Primary)}
                                    >
                                        "▾"
                                    </summary>
                                    <a href={ShippingWorkflow::at(next)}>
                                        "Skip to "{next.label()}" before this step is done"
                                    </a>
                                </details>
                            }
                        </span>
                    }
                }
            }
            if let Some(warning) = unshipped_warning {
                <dialog id={NewBatchDialogId} aria-labelledby={NewBatchHeadingId} class={Confirm}>
                    <h2 id={NewBatchHeadingId}>"Start a new batch?"</h2>
                    <p>{warning}</p>
                    <form method="post" action={super::super::url::NewBatch} class={row(Space::_2)}>
                        <button
                            type="button"
                            command="close"
                            commandfor={NewBatchDialogId}
                            class={Button}
                        >
                            "Keep This Batch"
                        </button>
                        <button class={(Button, Caution)}>"Start New Batch"</button>
                    </form>
                </dialog>
            }
        </section>
    }
}

/// The Buy Postage step's action: postage for every shipment, a label size at a time. In test
/// mode it says so in the warning color, as the React button did.
#[component(css = ShippingWorkflowScreen)]
pub fn BuyAllAction(mode: EasyPostMode, shipments: usize) -> impl Render {
    let test = mode == EasyPostMode::Test;
    html! {
        <form method="post" action={super::super::url::BuyAllPostage} class={Act}>
            <button
                disabled={shipments == 0 || !mode.has_key()}
                class={(Button, Primary, test.then_some(TestMode))}
            >
                "Buy All Postage"
            </button>
        </form>
    }
}

/// The Ship step's action: tracking applied and buyers told for the orders still pending. It
/// waits for a seller key, since buyers are told with it.
#[component(css = ShippingWorkflowScreen)]
pub fn ShipAction(pending: usize, has_seller: bool) -> impl Render {
    html! {
        <form method="post" action={super::super::url::ShipOrders} class={Act}>
            <button disabled={pending == 0 || !has_seller} class={(Button, Primary)}>
                "Mark Shipped & Notify Buyers"
            </button>
        </form>
    }
}
