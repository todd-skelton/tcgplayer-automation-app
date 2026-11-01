use corten::prelude::*;

use crate::{
    features::{
        shipping_configuration::{self, EasyPostMode},
        shipping_export::{
            steps::{Progress, Step},
            url::{OrderLabels, ShippingWorkflow},
        },
    },
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        button::{Button, ButtonSize, ButtonVariant},
        dialog::{Dialog, DialogFooter},
    },
};

#[derive(Id)]
struct NewBatchDialogId;
#[derive(Id)]
struct NewBatchHeadingId;
#[derive(Id)]
struct RefusedId;

/// Why the last post on the page was refused; empty when it was not. A refused post with
/// JavaScript replaces it alone, so the page keeps what the user had in front of them.
#[component]
pub fn Refused<'a>(problem: Option<&'a str>) -> impl Patch {
    html! {
        <div id={RefusedId} role="alert">
            if let Some(problem) = problem {
                <Alert variant={AlertVariant::Warning}>{problem}</Alert>
            }
        </div>
    }
}

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
                <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                    <a href={OrderLabels { order: None }}>"Label Management"</a>
                </Button>
                <a
                    href={shipping_configuration::url::ShippingSettings}
                    aria-label="Shipping configuration"
                    title="Shipping configuration"
                    class={Settings}
                >
                    "⚙"
                </a>
            </header>
            <Refused problem={problem} />
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
                <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                    <a href={ShippingWorkflow::at(back)}>"Back"</a>
                </Button>
            }
            match step.next() {
                None => {
                    if unshipped_warning.is_some() {
                        <Button variant={ButtonVariant::Success} size={ButtonSize::Md}>
                            <button
                                type="button"
                                command="show-modal"
                                commandfor={NewBatchDialogId}
                            >
                                "Start New Batch"
                            </button>
                        </Button>
                    } else {
                        <form method="post" action={super::super::url::NewBatch}>
                            <Button variant={ButtonVariant::Success} size={ButtonSize::Md}>
                                <button>"Start New Batch"</button>
                            </Button>
                        </form>
                    }
                }
                Some(next) => {
                    if progress.ready {
                        <Button variant={ButtonVariant::Primary} size={ButtonSize::Md}>
                            <a href={ShippingWorkflow::at(next)}>"Continue to "{next.label()}</a>
                        </Button>
                    } else {
                        <span class={Split}>
                            <Button variant={ButtonVariant::Primary} size={ButtonSize::Md}>
                                <button type="button" disabled>"Continue to "{next.label()}</button>
                            </Button>
                            if progress.can_skip {
                                <details class={Skip}>
                                    <summary
                                        aria-label="More ways to continue"
                                        class={SkipToggle}
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
                <Dialog>
                    <dialog id={NewBatchDialogId} aria-labelledby={NewBatchHeadingId}>
                        <h2 id={NewBatchHeadingId}>"Start a new batch?"</h2>
                        <p>{warning}</p>
                        <form method="post" action={super::super::url::NewBatch}>
                            <DialogFooter>
                                <Button variant={ButtonVariant::Ghost} size={ButtonSize::Md}>
                                    <button
                                        type="button"
                                        command="close"
                                        commandfor={NewBatchDialogId}
                                    >
                                        "Keep This Batch"
                                    </button>
                                </Button>
                                <Button variant={ButtonVariant::Warning} size={ButtonSize::Md}>
                                    <button>"Start New Batch"</button>
                                </Button>
                            </DialogFooter>
                        </form>
                    </dialog>
                </Dialog>
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
        <form method="post" action={super::super::url::BuyAllPostage} class={Act} data-patch>
            <Button
                variant={if test { ButtonVariant::Warning } else { ButtonVariant::Primary }}
                size={ButtonSize::Md}
            >
                <button disabled={shipments == 0 || !mode.has_key()}>"Buy All Postage"</button>
            </Button>
        </form>
    }
}

/// The Ship step's action: tracking applied and buyers told for the orders still pending. It
/// waits for a seller key, since buyers are told with it.
#[component(css = ShippingWorkflowScreen)]
pub fn ShipAction(pending: usize, has_seller: bool) -> impl Render {
    html! {
        <form method="post" action={super::super::url::ShipOrders} class={Act} data-patch>
            <Button variant={ButtonVariant::Primary} size={ButtonSize::Md}>
                <button disabled={pending == 0 || !has_seller}>
                    "Mark Shipped & Notify Buyers"
                </button>
            </Button>
        </form>
    }
}
