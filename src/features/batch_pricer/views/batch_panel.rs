use std::time::SystemTime;

use corten::{i18n::DateStyle, prelude::*};
use corten_ui::{Tooltip, dialog};

use super::{
    batch_summary::BatchSummary,
    publish_dialog::{PublishDialog, PublishDialogId},
};
use crate::{
    features::batch_pricer::{
        batches::{
            Batch, BatchStatus, Job, JobStatus, Mode as Pricing, Progress, Publications, RunStatus,
            Scope,
        },
        page::{PriceInput, Shown, elapsed},
        url,
    },
    layout::{DialogNotSent, Notice},
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardPanel, CardSize},
        dialog::{Dialog, DialogFooter, DialogSize},
        icon::{self, Icon},
        progress::{Progress as ProgressLook, ProgressSize, ProgressTone},
        tip::Tip,
    },
};

#[derive(Id)]
pub struct BatchFollowId;
#[derive(Id)]
pub struct BatchPanelId;
#[derive(Id)]
pub struct BatchProblemId;
/// What pricing the batch queues.
#[derive(Id)]
struct PriceBatchTipId;
#[derive(Id)]
struct DeleteDialogId;
#[derive(Id)]
struct DeleteHeadingId;

/// Why the last post on the batch was refused, above it; empty when it was not.
#[component]
pub fn BatchProblem<'a>(message: Option<&'a str>) -> impl Patch {
    html! {
        <div id={BatchProblemId}>
            if let Some(message) = message {
                <Notice variant={AlertVariant::Warning}>{message}</Notice>
            }
        </div>
    }
}

/// The batch shown and, while it prices or publishes, the stream that sends its panel again each
/// time it changes. A post's answer replaces it, so a batch that starts pricing is followed.
#[component]
pub fn BatchFollow<'a>(shown: &'a Shown, t: Msg) -> impl Patch {
    html! {
        <div id={BatchFollowId}>
            if shown.following() {
                <corten-live
                    src={url::Live { batch: shown.batch.batch_number }}
                    since={shown.version()}
                >
                    <BatchPanel shown={shown} t={t} />
                </corten-live>
            } else {
                <BatchPanel shown={shown} t={t} />
            }
        </div>
    }
}

/// Everything about the batch that changes as it prices or publishes: its card, the actions it
/// allows now, its progress, its summary and the dialogs its actions open.
#[component(css)]
pub fn BatchPanel<'a>(shown: &'a Shown, t: Msg) -> impl Patch {
    let batch = &shown.batch;
    let n = batch.batch_number;
    let publications = shown.publications.as_ref().ok();
    let busy = batch.pricing() || publications.is_some_and(Publications::active);
    let priced = batch.has_results();
    let preview = publications.and_then(|p| p.preview.as_ref());
    let ready = preview.map_or(0, |p| p.eligible_count);
    let said = refs();
    let can_publish = !busy && ready > 0 && publications.is_some_and(|p| !p.plan_exists());
    let can_delete = !batch.pricing() && publications.is_some_and(|p| p.publications.is_empty());
    let mode = PriceInput::FIELDS.mode;
    let failed = batch
        .latest_job
        .as_ref()
        .filter(|j| j.status == JobStatus::Failed);
    html! {
        <div id={BatchPanelId} class={BatchPanel}>
            <section class={CardPanel { size: CardSize::Sm }}>
                <SummaryCard batch={batch} t={t} />
            </section>
            <section class={(CardPanel { size: CardSize::Sm }, display_grid(), gap_3())}>
                <h2>"Actions"</h2>
                <div class={Actions}>
                    <form
                        method="post"
                        action={url::Price { batch: n }}
                        data-patch
                        class={row(Space::_2)}
                    >
                        <button
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            name={mode}
                            value={Pricing::Full}
                            disabled={busy}
                            interestfor={PriceBatchTipId}
                            aria-describedby={PriceBatchTipId}
                        >
                            if priced { "Reprice Batch" } else { "Price Batch" }
                        </button>
                        <Tooltip id={PriceBatchTipId} class={Tip {}}>
                            "Will queue pricing for "{batch.item_count}
                            " SKUs using the server pricing configuration"
                        </Tooltip>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                            name={mode}
                            value={Pricing::Errors}
                            disabled={busy || !priced || batch.manual_review_count == 0}
                        >
                            "Reprice Errors ("{batch.manual_review_count}")"
                        </button>
                    </form>
                    <div class={row(Space::_2)}>
                        <Download
                            batch={n}
                            scope={Scope::Successful}
                            label="Successful"
                            count={batch.successful_count}
                            ready={priced}
                        />
                        <Download
                            batch={n}
                            scope={Scope::ManualReview}
                            label="Manual Review / Errors"
                            count={batch.manual_review_count}
                            ready={priced}
                        />
                    </div>
                    <button
                        class={Button { variant: ButtonVariant::Success, size: ButtonSize::Md }}
                        type="button"
                        command="show-modal"
                        commandfor={PublishDialogId}
                        disabled={!can_publish}
                    >
                        "Publish ("{ready}")"
                    </button>
                    <button
                        class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}
                        type="button"
                        command="show-modal"
                        commandfor={DeleteDialogId}
                        disabled={!can_delete}
                    >
                        "Delete Batch"
                    </button>
                </div>
                if let Some(p) = preview {
                    <Notice
                        variant={if p.excluded_count > 0 { AlertVariant::Warning } else { AlertVariant::Info }}
                    >
                        {p.eligible_count}" SKU"{if p.eligible_count == 1 { "" } else { "s" }}
                        " ready to publish; "{p.excluded_count}" excluded by safety checks."
                    </Notice>
                }
                if let Some(run) = publications.and_then(Publications::latest_run) {
                    <Notice variant={run_tone(run.status)}>
                        "Latest pricing run: "{run.status.word()}". Published "{run.published}
                        " across "{run.publications}" publication batch"
                        {if run.publications == 1 { "" } else { "es" }}
                        ", failed "{run.failed}", ambiguous "{run.ambiguous}"."
                    </Notice>
                }
                if let Err(message) = &shown.publications {
                    <Notice variant={AlertVariant::Warning}>
                        "The batch's publications could not be read: "{message}
                    </Notice>
                }
            </section>
            if let Some(job) = batch.latest_job.as_ref().filter(|j| j.active()) {
                <JobProgress job={job} batch={n} />
            }
            if let Some(job) = failed {
                <Notice variant={AlertVariant::Warning}>
                    {job.error_message.clone().unwrap_or_else(|| format!("Batch {n} pricing failed"))}
                </Notice>
            }
            if let Some(summary) = &batch.summary {
                <p class={muted()}>"Current batch summary for the saved pricing results."</p>
                <BatchSummary
                    summary={summary}
                    last_priced={batch.last_priced_at}
                    rates={shown.rates}
                    t={t}
                />
            }
            if let (true, Some(p)) = (can_publish, publications) {
                <PublishDialog batch={n} publications={p} t={t} />
            }
            if can_delete {
                <dialog
                    id={DeleteDialogId}
                    aria-labelledby={DeleteHeadingId}
                    class={Dialog { size: DialogSize::Sm }}
                    on:corten:error={dialog::failed(event, target, said)}
                >
                    <h2 id={DeleteHeadingId}>"Delete Batch "{n}"?"</h2>
                    <p>
                        "This removes the batch, its "{batch.item_count}
                        " frozen items, and all saved pricing results. This cannot be undone."
                    </p>
                    <DialogNotSent said={said} />
                    <form
                        method="post"
                        action={url::Delete { batch: n }}
                        data-patch
                        class={DialogFooter {}}
                    >
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                            type="button"
                            command="close"
                            commandfor={DeleteDialogId}
                        >
                            "Cancel"
                        </button>
                        <button
                            class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}
                        >
                            "Delete Batch"
                        </button>
                    </form>
                </dialog>
            }
        </div>
    }
}

fn run_tone(status: RunStatus) -> AlertVariant {
    match status {
        RunStatus::Published => AlertVariant::Success,
        RunStatus::Failed | RunStatus::Ambiguous => AlertVariant::Warning,
        RunStatus::InProgress => AlertVariant::Info,
    }
}

/// A download of the batch's saved rows, or the same words disabled while it has none.
#[component(css = BatchPanel)]
fn Download<'a>(batch: i32, scope: Scope, label: &'a str, count: i64, ready: bool) -> impl Render {
    html! {
        if ready && count > 0 {
            <a
                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                href={url::Results { batch, scope }}
                download
            >
                <Icon glyph={icon::DOWNLOAD} />
                {label}" ("{count}")"
            </a>
        } else {
            <button
                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                type="button"
                disabled
            >
                <Icon glyph={icon::DOWNLOAD} />
                {label}" ("{count}")"
            </button>
        }
    }
}

/// The batch's number, where it came from, its status and counts, and when it was made and priced.
#[component(css = BatchPanel)]
fn SummaryCard<'a>(batch: &'a Batch, t: Msg) -> impl Render {
    let source = match batch.source_type.as_str() {
        "seller" => BadgeTone::Primary,
        "csv" => BadgeTone::Info,
        _ => BadgeTone::Success,
    };
    let status = match batch.status {
        BatchStatus::Priced => BadgeTone::Success,
        BatchStatus::Queued => BadgeTone::Info,
        BatchStatus::Pricing => BadgeTone::Primary,
        BatchStatus::Failed => BadgeTone::Destructive,
        BatchStatus::Pending => BadgeTone::Neutral,
    };
    let produced_none = batch
        .latest_job
        .as_ref()
        .is_some_and(|j| j.status == JobStatus::Completed);
    let job = batch.latest_job.as_ref().map(|job| {
        let tone = match job.status {
            JobStatus::Completed => BadgeTone::Success,
            JobStatus::Queued => BadgeTone::Info,
            JobStatus::Pricing => BadgeTone::Primary,
            JobStatus::Failed => BadgeTone::Destructive,
        };
        (
            format!("{} job: {}", job.mode.word(), job.status.word()),
            tone,
        )
    });
    html! {
        <div class={row(Space::_2)}>
            <h2>"Batch "{batch.batch_number}</h2>
            <span class={Badge { tone: source, emphasis: BadgeEmphasis::Outline }}>
                {batch.source()}
            </span>
            <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Outline }}>
                {batch.item_count}" SKUs"
            </span>
            <span class={Badge { tone: status, emphasis: BadgeEmphasis::Solid }}>
                {batch.status.word()}
            </span>
            if let Some((words, tone)) = &job {
                <span class={Badge { tone: *tone, emphasis: BadgeEmphasis::Outline }}>{words}</span>
            }
            <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Outline }}>
                {batch.successful_count}" successful"
            </span>
            <span class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Outline }}>
                {batch.manual_review_count}" manual review/errors"
            </span>
        </div>
        <div class={(row(Space::_2), Timeline)}>
            <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Solid }}>
                "Created "{t.date(batch.created_at, DateStyle::Short)}
            </span>
            <span class={if batch.last_priced_at.is_some() { (Line, Ok) } else { (Line, Plain) }}></span>
            match batch.last_priced_at {
                Some(at) => {
                    <span
                        class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Solid }}
                    >
                        "Priced "{t.date(at, DateStyle::Short)}
                    </span>
                }
                None => {
                    <span
                        class={(Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }, Dashed)}
                    >
                        if produced_none { "No prices produced" } else { "Not yet priced" }
                    </span>
                }
            }
        </div>
    }
}

/// How far the batch's pricing job got, as its worker reports it; a queued job reads as queued.
#[component(css = BatchPanel)]
fn JobProgress<'a>(job: &'a Job, batch: i32) -> impl Render {
    let p = match (job.status, &job.progress) {
        (JobStatus::Pricing, Some(progress)) => progress.clone(),
        _ => Progress {
            current: 0.0,
            total: 1.0,
            status: format!("Batch {batch} is queued for pricing..."),
            phase: Some("Queued".to_owned()),
            ..Progress::default()
        },
    };
    let percent = if p.total > 0.0 {
        p.current / p.total * 100.0
    } else {
        0.0
    };
    let since = p.phase_start_time.map(|at| elapsed(at, SystemTime::now()));
    html! {
        <section
            class={(CardPanel { size: CardSize::Sm }, JobProgress)}
            aria-label="Processing progress"
        >
            <header class={row(Space::_2)}>
                <h2>"Processing Progress"</h2>
                if let Some(phase) = &p.phase {
                    <span
                        class={Badge { tone: BadgeTone::Primary, emphasis: BadgeEmphasis::Outline }}
                    >
                        {phase}
                    </span>
                    if let Some(since) = &since {
                        <small class={muted()}>{since}</small>
                    }
                }
            </header>
            <div class={Between}>
                <span class={muted()}>
                    if p.total == 0.0 {
                        "Initializing..."
                    } else {
                        "Step "{p.current}" of "{p.total}
                    }
                </span>
                if p.total > 0.0 {
                    <strong class={muted()}>{percent.round()}"%"</strong>
                }
            </div>
            if p.total > 0.0 {
                <progress
                    class={ProgressLook { size: ProgressSize::Md, tone: ProgressTone::Primary }}
                    max="100"
                    value={percent}
                    aria-label="Batch pricing progress"
                >
                    {percent.round()}"%"
                </progress>
            } else {
                <progress
                    class={ProgressLook { size: ProgressSize::Md, tone: ProgressTone::Primary }}
                    aria-label="Batch pricing progress"
                >
                    "Starting"
                </progress>
            }
            <p>{&p.status}</p>
            if let Some(sub) = &p.sub_progress {
                <div class={Sub}>
                    <div class={Between}>
                        <span class={muted()}>{sub.current}" of "{sub.total}" items"</span>
                        <strong class={muted()}>
                            {if sub.total > 0.0 { (sub.current / sub.total * 100.0).round() } else { 0.0 }}
                            "%"
                        </strong>
                    </div>
                    <progress
                        class={ProgressLook { size: ProgressSize::Sm, tone: ProgressTone::Primary }}
                        max={sub.total.max(1.0)}
                        value={sub.current}
                        aria-label="Items in this step"
                    >
                        {sub.current}" of "{sub.total}
                    </progress>
                    <small class={muted()}>{&sub.status}</small>
                </div>
            }
            <div class={row(Space::_2)}>
                <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Solid }}>
                    "Processed: "{p.processed}
                </span>
                <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Solid }}>
                    "Skipped: "{p.skipped}
                </span>
                <span class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Solid }}>
                    "Warnings: "{p.warnings}
                </span>
                <span
                    class={Badge { tone: BadgeTone::Destructive, emphasis: BadgeEmphasis::Solid }}
                >
                    "Errors: "{p.errors}
                </span>
            </div>
        </section>
    }
}
