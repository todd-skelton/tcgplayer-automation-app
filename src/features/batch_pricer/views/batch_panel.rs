use std::time::SystemTime;

use corten::{i18n::DateStyle, prelude::*};

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
    layout::{Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

#[derive(Id)]
pub struct BatchFollowId;
#[derive(Id)]
pub struct BatchPanelId;
#[derive(Id)]
pub struct BatchProblemId;
#[derive(Id)]
struct DeleteDialogId;
#[derive(Id)]
struct DeleteHeadingId;

/// Why the last post on the batch was refused, above it; empty when it was not.
#[component]
pub fn BatchProblem<'a>(message: Option<&'a str>) -> impl Patch {
    html! {
        <div id={BatchProblemId} role="alert">
            if let Some(message) = message {
                <Notice tone={Tone::Warning}>{message}</Notice>
            }
        </div>
    }
}

/// The batch shown and, while it prices or publishes, the stream that sends its panel again each
/// time it changes. A post's answer replaces it, so a batch that starts pricing is followed.
#[component]
pub fn BatchFollow<'a>(shown: &'a Shown, t: Msg, visitor: Visitor) -> impl Patch {
    html! {
        <div id={BatchFollowId}>
            if shown.following() {
                <corten-live
                    src={url::Live { batch: shown.batch.batch_number }}
                    since={shown.version()}
                >
                    <BatchPanel shown={shown} t={t} visitor={visitor} />
                </corten-live>
            } else {
                <BatchPanel shown={shown} t={t} visitor={visitor} />
            }
        </div>
    }
}

/// Everything about the batch that changes as it prices or publishes: its card, the actions it
/// allows now, its progress, its summary and the dialogs its actions open.
#[component(css)]
pub fn BatchPanel<'a>(shown: &'a Shown, t: Msg, visitor: Visitor) -> impl Patch {
    let batch = &shown.batch;
    let n = batch.batch_number;
    let publications = shown.publications.as_ref().ok();
    let busy = batch.pricing() || publications.is_some_and(Publications::active);
    let priced = batch.has_results();
    let preview = publications.and_then(|p| p.preview.as_ref());
    let ready = preview.map_or(0, |p| p.eligible_count);
    let can_publish = !busy && ready > 0 && publications.is_some_and(|p| !p.plan_exists());
    let can_delete = !batch.pricing() && publications.is_some_and(|p| p.publications.is_empty());
    let mode = PriceInput::FIELDS.mode;
    let failed = batch
        .latest_job
        .as_ref()
        .filter(|j| j.status == JobStatus::Failed);
    html! {
        <div id={BatchPanelId} class={BatchPanel}>
            <section class={panel()}>
                <SummaryCard batch={batch} t={t} visitor={visitor} />
            </section>
            <section class={panel()}>
                <h2>"Actions"</h2>
                <div class={Actions}>
                    <form
                        method="post"
                        action={url::Price { batch: n }}
                        data-patch
                        class={row(Space::_2)}
                    >
                        <button
                            name={mode}
                            value={Pricing::Full}
                            data-primary
                            disabled={busy}
                            title={format!("Will queue pricing for {} SKUs using the server pricing configuration", batch.item_count)}
                        >
                            if priced { "Reprice Batch" } else { "Price Batch" }
                        </button>
                        <button
                            name={mode}
                            value={Pricing::Errors}
                            class={Caution}
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
                        type="button"
                        command="show-modal"
                        commandfor={PublishDialogId}
                        class={Publish}
                        disabled={!can_publish}
                    >
                        "Publish ("{ready}")"
                    </button>
                    <button
                        type="button"
                        command="show-modal"
                        commandfor={DeleteDialogId}
                        class={Danger}
                        disabled={!can_delete}
                    >
                        "Delete Batch"
                    </button>
                </div>
                if let Some(p) = preview {
                    <Notice tone={if p.excluded_count > 0 { Tone::Warning } else { Tone::Info }}>
                        {p.eligible_count}" SKU"{if p.eligible_count == 1 { "" } else { "s" }}
                        " ready to publish; "{p.excluded_count}" excluded by safety checks."
                    </Notice>
                }
                if let Some(run) = publications.and_then(Publications::latest_run) {
                    <Notice tone={run_tone(run.status)}>
                        "Latest pricing run: "{run.status.word()}". Published "{run.published}
                        " across "{run.publications}" publication batch"
                        {if run.publications == 1 { "" } else { "es" }}
                        ", failed "{run.failed}", ambiguous "{run.ambiguous}"."
                    </Notice>
                }
                if let Err(message) = &shown.publications {
                    <Notice tone={Tone::Warning}>
                        "The batch's publications could not be read: "{message}
                    </Notice>
                }
            </section>
            if let Some(job) = batch.latest_job.as_ref().filter(|j| j.active()) {
                <JobProgress job={job} batch={n} />
            }
            if let Some(job) = failed {
                <Notice tone={Tone::Warning}>
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
                    visitor={visitor}
                />
            }
            if let (true, Some(p)) = (can_publish, publications) {
                <PublishDialog batch={n} publications={p} t={t} />
            }
            if can_delete {
                <dialog id={DeleteDialogId} aria-labelledby={DeleteHeadingId} class={Confirm}>
                    <h2 id={DeleteHeadingId}>"Delete Batch "{n}"?"</h2>
                    <p>
                        "This removes the batch, its "{batch.item_count}
                        " frozen items, and all saved pricing results. This cannot be undone."
                    </p>
                    <form
                        method="post"
                        action={url::Delete { batch: n }}
                        data-patch
                        class={row(Space::_2)}
                    >
                        <button type="button" command="close" commandfor={DeleteDialogId}>
                            "Cancel"
                        </button>
                        <button class={Danger}>"Delete Batch"</button>
                    </form>
                </dialog>
            }
        </div>
    }
}

fn run_tone(status: RunStatus) -> Tone {
    match status {
        RunStatus::Published => Tone::Done,
        RunStatus::Failed | RunStatus::Ambiguous => Tone::Warning,
        RunStatus::InProgress => Tone::Info,
    }
}

/// A download of the batch's saved rows, or the same words disabled while it has none.
#[component(css = BatchPanel)]
fn Download<'a>(batch: i32, scope: Scope, label: &'a str, count: i64, ready: bool) -> impl Render {
    html! {
        if ready && count > 0 {
            <a href={url::Results { batch, scope }} download class={ButtonLink}>
                "⤓ "{label}" ("{count}")"
            </a>
        } else {
            <button type="button" disabled>"⤓ "{label}" ("{count}")"</button>
        }
    }
}

/// The batch's number, where it came from, its status and counts, and when it was made and priced.
#[component(css = BatchPanel)]
fn SummaryCard<'a>(batch: &'a Batch, t: Msg, visitor: Visitor) -> impl Render {
    let source = match batch.source_type.as_str() {
        "seller" => Secondary,
        "csv" => Info,
        _ => Ok,
    };
    let status = match batch.status {
        BatchStatus::Priced => Ok,
        BatchStatus::Queued => Info,
        BatchStatus::Pricing => Accent,
        BatchStatus::Failed => Bad,
        BatchStatus::Pending => Plain,
    };
    let produced_none = batch
        .latest_job
        .as_ref()
        .is_some_and(|j| j.status == JobStatus::Completed);
    let job = batch.latest_job.as_ref().map(|job| {
        let tone = match job.status {
            JobStatus::Completed => Ok,
            JobStatus::Queued => Info,
            JobStatus::Pricing => Accent,
            JobStatus::Failed => Bad,
        };
        (
            format!("{} job: {}", job.mode.word(), job.status.word()),
            tone,
        )
    });
    html! {
        <div class={row(Space::_2)}>
            <h2>"Batch "{batch.batch_number}</h2>
            <span class={(Chip, source)}>{batch.source()}</span>
            <span class={(Chip, Info)}>{batch.item_count}" SKUs"</span>
            <span class={(Chip, Filled, status)}>{batch.status.word()}</span>
            if let Some((words, tone)) = &job {
                <span class={(Chip, *tone)}>{words}</span>
            }
            <span class={(Chip, Ok)}>{batch.successful_count}" successful"</span>
            <span class={(Chip, Warn)}>{batch.manual_review_count}" manual review/errors"</span>
        </div>
        <div class={(row(Space::_2), Timeline)}>
            <span class={(Chip, Filled, Ok)}>
                "Created "{t.date(batch.created_at, DateStyle::Short).zone(visitor)}
            </span>
            <span class={if batch.last_priced_at.is_some() { (Line, Ok) } else { (Line, Plain) }}></span>
            match batch.last_priced_at {
                Some(at) => {
                    <span class={(Chip, Filled, Ok)}>
                        "Priced "{t.date(at, DateStyle::Short).zone(visitor)}
                    </span>
                }
                None => {
                    <span class={(Chip, Dashed)}>
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
        <section class={(panel(), JobProgress)} aria-label="Processing progress">
            <header class={row(Space::_2)}>
                <h2>"Processing Progress"</h2>
                if let Some(phase) = &p.phase {
                    <span class={(Chip, Accent)}>{phase}</span>
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
            if p.total == 0.0 {
                <progress aria-label="Batch pricing progress"></progress>
            } else {
                <progress max="100" value={percent} aria-label="Batch pricing progress"></progress>
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
                        max="100"
                        value={if sub.total > 0.0 { sub.current / sub.total * 100.0 } else { 0.0 }}
                        aria-label="Items in this step"
                    ></progress>
                    <small class={muted()}>{&sub.status}</small>
                </div>
            }
            <div class={row(Space::_2)}>
                <span class={(Chip, Filled, Ok)}>"Processed: "{p.processed}</span>
                <span class={(Chip, Filled, Info)}>"Skipped: "{p.skipped}</span>
                <span class={(Chip, Filled, Warn)}>"Warnings: "{p.warnings}</span>
                <span class={(Chip, Filled, Bad)}>"Errors: "{p.errors}</span>
            </div>
        </section>
    }
}
