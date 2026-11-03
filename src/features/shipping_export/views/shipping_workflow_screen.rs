use corten::prelude::*;

use crate::{
    features::{
        shipping_configuration::{self, EasyPostMode},
        shipping_export::{
            steps::{Progress, Step},
            url::{OrderLabels, ShippingWorkflow},
        },
    },
    ui::{
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        dialog::{Dialog, DialogFooter},
        popover::Popover,
        steps::{Step as StepLink, StepState, Steps, StepsLayout},
    },
};

#[derive(Id)]
struct NewBatchDialogId;
#[derive(Id)]
struct NewBatchHeadingId;
#[derive(Id)]
struct RefusedId;
/// The split button's other way on: skip ahead before the step is done.
#[derive(Id)]
struct SkipPopoverId;

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
        let links = Step::ALL.map(ShippingWorkflow::at);
        let steps = steps(step, &links);
        <div class={ShippingWorkflowScreen}>
            <header class={Header}>
                <h1>"Shipping Workflow"</h1>
                <div class={StepsSlot}>
                    <Steps label="Steps" layout={StepsLayout::Row} steps={&steps} />
                </div>
                if let Some(warning) = mode_warning(mode) {
                    <span
                        class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Outline }}
                    >
                        {warning}
                    </span>
                }
                <a
                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    href={OrderLabels { order: None }}
                >
                    "Label Management"
                </a>
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
            <section aria-label={step.label()} class={(CardPanel {}, CardCompact {}, StepPanel)}>
                {children}
            </section>
            {bar}
        </div>
    }
}

/// The workflow's steps for the kit's `Steps`: those before the current one done, the rest not
/// started, each a link to its step.
fn steps<'a>(current: Step, links: &'a [ShippingWorkflow; 6]) -> Vec<StepLink<'a>> {
    Step::ALL
        .iter()
        .zip(links)
        .map(|(&each, link)| StepLink {
            label: each.label(),
            description: None,
            link: Some(link),
            state: if each == current {
                StepState::Current
            } else if each.before(current) {
                StepState::Done("(done)")
            } else {
                StepState::Todo("(not started)")
            },
        })
        .collect()
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
                <a
                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    href={ShippingWorkflow::at(back)}
                >
                    "Back"
                </a>
            }
            match step.next() {
                None => {
                    if unshipped_warning.is_some() {
                        <button
                            class={Button { variant: ButtonVariant::Success, size: ButtonSize::Md }}
                            type="button"
                            command="show-modal"
                            commandfor={NewBatchDialogId}
                        >
                            "Start New Batch"
                        </button>
                    } else {
                        <form method="post" action={super::super::url::NewBatch}>
                            <button
                                class={Button { variant: ButtonVariant::Success, size: ButtonSize::Md }}
                            >
                                "Start New Batch"
                            </button>
                        </form>
                    }
                }
                Some(next) => {
                    if progress.ready {
                        <a
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            href={ShippingWorkflow::at(next)}
                        >
                            "Continue to "{next.label()}
                        </a>
                    } else {
                        <span class={Split}>
                            <button
                                class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                                type="button"
                                disabled
                            >
                                "Continue to "{next.label()}
                            </button>
                            if progress.can_skip {
                                <button
                                    class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                                    type="button"
                                    popovertarget={SkipPopoverId}
                                    aria-label="More ways to continue"
                                >
                                    "▾"
                                </button>
                                <div popover id={SkipPopoverId} class={(Popover {}, Skip)}>
                                    <a href={ShippingWorkflow::at(next)}>
                                        "Skip to "{next.label()}" before this step is done"
                                    </a>
                                </div>
                            }
                        </span>
                    }
                }
            }
            if let Some(warning) = unshipped_warning {
                <dialog class={Dialog {}} id={NewBatchDialogId} aria-labelledby={NewBatchHeadingId}>
                    <h2 id={NewBatchHeadingId}>"Start a new batch?"</h2>
                    <p>{warning}</p>
                    <form method="post" action={super::super::url::NewBatch}>
                        <div class={DialogFooter {}}>
                            <button
                                class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }}
                                type="button"
                                command="close"
                                commandfor={NewBatchDialogId}
                            >
                                "Keep This Batch"
                            </button>
                            <button
                                class={Button { variant: ButtonVariant::Warning, size: ButtonSize::Md }}
                            >
                                "Start New Batch"
                            </button>
                        </div>
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
        <form method="post" action={super::super::url::BuyAllPostage} class={Act} data-patch>
            <button
                class={Button { variant: if test { ButtonVariant::Warning } else { ButtonVariant::Primary }, size: ButtonSize::Md }}
                disabled={shipments == 0 || !mode.has_key()}
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
        <form method="post" action={super::super::url::ShipOrders} class={Act} data-patch>
            <button
                class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                disabled={pending == 0 || !has_seller}
            >
                "Mark Shipped & Notify Buyers"
            </button>
        </form>
    }
}
