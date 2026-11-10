use chrono::{DateTime, Utc};
use corten::{
    ReadAgain,
    form::keep_query,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::ordered;

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{CancelInput, RefreshInput},
            identity::{Record, words},
            page::{Place, REFRESHING, Screen},
            research::{EvidenceStatus, PSA_GRADES, Workspace},
            url::{self, Choice},
            views::Problem,
        },
    },
    layout::Notice,
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        field::Field,
        input::Input,
        select::Select,
        status_dot::{StatusDot, StatusTone},
    },
};

// These forms' answers carry no field errors: a refusal is the place's Problem. Their fields are
// named from the form's id through Within::none.
#[derive(Id)]
struct ResearchFormId;

#[derive(Id)]
struct EvidenceListId;

/// The certificate's research: the grade and sale dates, refreshing the evidence, and what is
/// saved for them.
#[component(css = super::slab_screen::SlabScreen)]
pub fn ResearchPanel<'a>(screen: &'a Screen, record: &'a Record, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let window = choice.window();
    let grade = choice.grade();
    let owned = record.shown().map_or("", |s| s.grading.encoding.as_str());
    let f = Choice::FIELDS;
    let r = RefreshInput::FIELDS;
    html! {
        <section
            class={(CardPanel {}, CardCompact {}, stack(Space::_3), ResearchPanel)}
            aria-labelledby="slab-research"
        >
            <h2 id="slab-research">"Research evidence"</h2>
            let e = Within::none(ResearchFormId);
            <form
                on:submit={ordered::send(event, target, super::sorted_tables())}
                id={ResearchFormId}
                method="get"
                action={url::SlabPricing::at(&Choice::default())}
                class={Line}
            >
                // A new grade or window starts the evidence over: its source, comps and extras reset.
                {keep_query(
                    &url::SlabPricing::at(&Choice {
                        source: None,
                        rows: None,
                        sources: Vec::new(),
                        comps: None,
                        comps_from: None,
                        comp: None,
                        extra: Vec::new(),
                        ..choice.clone()
                    }),
                    html! {
                    <Field id={e.id(f.grade)} label="Research grade" hint="" error="">
                        <select class={Select {}} {..e.control(f.grade)}>
                            <option value="owned" selected={grade == "owned"}>
                                "Owned "{&record.grader}" "{owned}
                            </option>
                            if record.grader == "PSA" {
                                for n in PSA_GRADES {
                                    <option value={n} selected={grade == n}>"Explore PSA "{n}</option>
                                }
                            }
                        </select>
                    </Field>
                    <Field id={e.id(f.from)} label="Sales from" hint="" error="">
                        <input class={Input {}} type="date" value={&window.from} required {..e.control(f.from)}>
                    </Field>
                    <Field id={e.id(f.to)} label="Sales through" hint="" error="">
                        <input class={Input {}} type="date" value={&window.to} required {..e.control(f.to)}>
                    </Field>
                    <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>"Show evidence"</button>
                    },
                )}
            </form>
            if grade != "owned" {
                <Notice variant={AlertVariant::Info}>
                    "Exploring PSA "{grade}". Owned "{&record.grader}" "{owned}
                    " is unchanged. Research evidence cannot be used to calculate or override the owned slab price."
                </Notice>
            }
            match &screen.research {
                Some(Err(why)) => <Notice variant={AlertVariant::Warning}>{why}</Notice>,
                _ => {
                    <form
                        on:submit={ordered::send(event, target, super::sorted_tables())}
                        method="post"
                        action={url::Refresh { choice: choice.clone() }}
                        data-patch
                        class={Line}
                    >
                        <input type="hidden" name={r.id} value={&record.id}>
                        <input type="hidden" name={r.revision} value={record.revision}>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Refresh evidence"
                        </button>
                        <a
                            on:connect={ordered::link(target, super::sorted_tables(), signal)}
                            href={url::SlabPricing::at(choice)}
                        >
                            "Reload saved status"
                        </a>
                        <a href={slab_connections::url::SlabConnections}>"Data connections"</a>
                    </form>
                }
            }
            <Problem at={Place::Research} why={screen.problem_at(Place::Research)} />
            <EvidenceList screen={screen} t={t} />
            if let Some(Ok(Workspace { grade_model: Some(model), .. })) = &screen.research {
                <Notice variant={AlertVariant::Info}>
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
    html! {
        <div id={EvidenceListId} class={stack(Space::_3)} aria-live="polite">
            if statuses.is_empty() && matches!(&screen.research, Some(Ok(_))) {
                <Notice variant={AlertVariant::Info}>
                    "No saved evidence for this grade and date window. Refresh to request it."
                </Notice>
            }
            for status in statuses {
                <EvidenceRow status={status} choice={choice} t={t} />
            }
        </div>
        {again}
    }
}

#[component(css = super::slab_screen::SlabScreen)]
fn EvidenceRow<'a>(status: &'a EvidenceStatus, choice: &'a Choice, t: Msg) -> impl Render {
    let fetched = status
        .fetched_at
        .as_deref()
        .and_then(|at| at.parse::<DateTime<Utc>>().ok());
    let c = CancelInput::FIELDS;
    html! {
        <div class={(Line, Row)}>
            <strong>{words(&status.spec.kind)}</strong>
            <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                {words(&status.state)}
            </span>
            if status.stale {
                <span class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Soft }}>
                    <StatusDot tone={StatusTone::Text} />
                    "Stale or not fetched"
                </span>
            } else {
                <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Soft }}>
                    <StatusDot tone={StatusTone::Text} />
                    "Fresh"
                </span>
            }
            <span class={muted()}>
                match fetched {
                    Some(at) => {
                        {t.date_time(at, DateStyle::Short, TimeStyle::Medium)}
                    }
                    None => "Not yet fetched",
                }
                if let Some(code) = &status.error_code {
                    " · "{words(code)}
                }
            </span>
            if let Some(revision) = &status.latest_revision {
                <a
                    on:connect={ordered::link(target, super::sorted_tables(), signal)}
                    href={url::SlabPricing::at(&choice.reviewing_comps(revision))}
                >
                    "Review saved comps"
                </a>
            }
            if status.pending() {
                <form
                    on:submit={ordered::send(event, target, super::sorted_tables())}
                    method="post"
                    action={url::Cancel { choice: choice.clone() }}
                    data-patch
                >
                    <input type="hidden" name={c.key} value={&status.key}>
                    <input type="hidden" name={c.run} value={&status.run_id}>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Cancel refresh"
                    </button>
                </form>
            }
        </div>
    }
}
