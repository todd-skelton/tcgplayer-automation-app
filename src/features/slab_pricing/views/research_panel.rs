use chrono::{DateTime, Utc};
use corten::{
    ReadAgain,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{CancelInput, RefreshInput},
            identity::{Record, words},
            page::{Place, REFRESHING, Screen},
            research::{EvidenceStatus, PSA_GRADES, Workspace},
            url::{self, Choice},
            views::{KeptChoice, Problem},
        },
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

#[derive(Id)]
struct EvidenceListId;

/// The certificate's research: the grade and sale dates, refreshing the evidence, and what is
/// saved for them.
#[component(css = super::slab_screen::SlabScreen)]
pub fn ResearchPanel<'a>(screen: &'a Screen, record: &'a Record, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let window = choice.window();
    let grade = choice.grade();
    let owned = record
        .shown()
        .map_or(String::new(), |s| s.grading.encoding.clone());
    let f = Choice::FIELDS;
    let r = RefreshInput::FIELDS;
    html! {
        <section class={(panel(), Stack, ResearchPanel)} aria-labelledby="slab-research">
            <h2 id="slab-research">"Research evidence"</h2>
            <form method="get" action={url::SlabPricing::at(&Choice::default())} class={Line}>
                <KeptChoice
                    choice={choice}
                    except={&[
                        f.grade,
                        f.from,
                        f.to,
                        f.source,
                        f.rows,
                        f.sources,
                        f.comps,
                        f.comps_from,
                        f.comp,
                        f.extra,
                    ]}
                />
                <Field label="Research grade" hint="">
                    <select name={f.grade}>
                        <option value="owned" selected={grade == "owned"}>
                            "Owned "{&record.grader}" "{&owned}
                        </option>
                        if record.grader == "PSA" {
                            for n in PSA_GRADES {
                                <option value={n} selected={grade == n}>"Explore PSA "{n}</option>
                            }
                        }
                    </select>
                </Field>
                <Field label="Sales from" hint="">
                    <input type="date" name={f.from} value={&window.from} required>
                </Field>
                <Field label="Sales through" hint="">
                    <input type="date" name={f.to} value={&window.to} required>
                </Field>
                <button>"Show evidence"</button>
            </form>
            if grade != "owned" {
                <Notice tone={Tone::Info}>
                    "Exploring PSA "{grade}". Owned "{&record.grader}" "{&owned}
                    " is unchanged. Research evidence cannot be used to calculate or override the owned slab price."
                </Notice>
            }
            match &screen.research {
                Some(Err(why)) => <Notice tone={Tone::Warning}>{why}</Notice>,
                _ => {
                    <form
                        method="post"
                        action={url::Refresh { choice: choice.clone() }}
                        data-patch
                        class={Line}
                    >
                        <input type="hidden" name={r.id} value={&record.id}>
                        <input type="hidden" name={r.revision} value={record.revision}>
                        <button>"Refresh evidence"</button>
                        <a href={url::SlabPricing::at(choice)}>"Reload saved status"</a>
                        <a href={slab_connections::url::SlabConnections}>"Data connections"</a>
                    </form>
                }
            }
            <Problem at={Place::Research} why={screen.problem_at(Place::Research)} />
            <EvidenceList screen={screen} t={t} />
            if let Some(Ok(Workspace { grade_model: Some(model), .. })) = &screen.research {
                <Notice tone={Tone::Info}>
                    "Cross-grade estimate unavailable. "{&model.reason}
                </Notice>
            }
        </section>
    }
}

/// The evidence saved for the grade and dates, and where each refresh stands. While one is
/// queued or running it reads itself again.
#[component(css = super::slab_screen::SlabScreen)]
pub fn EvidenceList<'a>(screen: &'a Screen, t: Msg) -> impl Patch {
    let statuses: &[EvidenceStatus] = match &screen.research {
        Some(Ok(workspace)) => &workspace.statuses,
        _ => &[],
    };
    // While a refresh is queued or running, the list reads itself again from its own route.
    let again = screen.refreshing().then(|| {
        ReadAgain { after: REFRESHING }.from(url::Evidence {
            choice: screen.choice.clone(),
        })
    });
    let choice = &screen.choice;
    let visitor = screen.visitor;
    html! {
        <div id={EvidenceListId} class={Stack} aria-live="polite">
            if statuses.is_empty() && matches!(&screen.research, Some(Ok(_))) {
                <Notice tone={Tone::Info}>
                    "No saved evidence for this grade and date window. Refresh to request it."
                </Notice>
            }
            for status in statuses {
                <EvidenceRow status={status} choice={choice} t={t} visitor={visitor} />
            }
        </div>
        {again}
    }
}

#[component(css = super::slab_screen::SlabScreen)]
fn EvidenceRow<'a>(
    status: &'a EvidenceStatus,
    choice: &'a Choice,
    t: Msg,
    visitor: Visitor,
) -> impl Render {
    let fetched = status
        .fetched_at
        .as_deref()
        .and_then(|at| at.parse::<DateTime<Utc>>().ok());
    let c = CancelInput::FIELDS;
    html! {
        <div class={(Line, Row)}>
            <strong>{words(&status.spec.kind)}</strong>
            <span class={Chip}>{words(&status.state)}</span>
            if status.stale {
                <span class={(Chip, Stale)}>"Stale or not fetched"</span>
            } else {
                <span class={(Chip, Fresh)}>"Fresh"</span>
            }
            <span class={muted()}>
                match fetched {
                    Some(at) => {
                        {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    }
                    None => "Not yet fetched",
                }
                if let Some(code) = &status.error_code {
                    " · "{words(code)}
                }
            </span>
            if let Some(revision) = &status.latest_revision {
                <a href={url::SlabPricing::at(&choice.reviewing_comps(revision))}>
                    "Review saved comps"
                </a>
            }
            if status.pending() {
                <form method="post" action={url::Cancel { choice: choice.clone() }} data-patch>
                    <input type="hidden" name={c.key} value={&status.key}>
                    <input type="hidden" name={c.run} value={&status.run_id}>
                    <button>"Cancel refresh"</button>
                </form>
            }
        </div>
    }
}
