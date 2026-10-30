use std::time::Duration;

use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use super::{
    margin_trend::MarginTrendPanel,
    performance_panel::PerformancePanel,
    said,
    selling_history_panel::SellingHistoryPanel,
    turnaround_panel::TurnaroundPanel,
    verdict_panel::{HurdleSweep, VerdictPanel},
};
use crate::{
    features::inventory_strategy::{
        actions::TurnaroundInput,
        screen::{Analysis, Screen},
        url::{self, View},
    },
    layout::{Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// How often a running analysis is read again, as the React screen polled it.
pub const ANALYSIS_EVERY: Duration = Duration::from_secs(5);

#[derive(Id)]
struct StrategyProblemId;

#[derive(Id)]
pub struct AnalysisStatusId;

/// The screen's id: an analysis that ends replaces the whole screen with its results.
#[derive(Id)]
pub struct StrategyScreenId;

/// Why the last post was refused, announced where the actions are.
#[component(css = StrategyScreen)]
pub fn Problem<'a>(why: Option<&'a str>) -> impl Patch {
    html! {
        <div id={StrategyProblemId} role="alert">
            if let Some(why) = why {
                <Notice tone={Tone::Warning}>{why}</Notice>
            }
        </div>
    }
}

/// How the pricing strategy is doing and what to change, top to bottom as the React screen.
#[component(css)]
pub fn StrategyScreen<'a>(
    screen: &'a Screen,
    input: &'a TurnaroundInput,
    errors: &'a Errors,
    t: Msg,
) -> impl Patch {
    let quiet = screen.view.quiet();
    let configured = !screen.seller_key.is_empty();
    let analysis_active = screen.analysis.as_ref().is_some_and(Analysis::active);
    html! {
        <section id={StrategyScreenId} class={StrategyScreen}>
            <header class={Heading}>
                <div>
                    <h1>"Inventory Strategy"</h1>
                    <p class={muted()}>
                        "How the current pricing strategy is doing and what to change: realized margin and profit per day, the hurdle to price at, how fast capital turns, and how fast inventory sells. Prices are published only by the pricing workflow."
                    </p>
                </div>
                <div class={Actions}>
                    <form method="post" action={url::Refresh { view: quiet.clone() }}>
                        <button disabled={!configured}>"Refresh inventory"</button>
                    </form>
                    <form method="post" action={url::QueueAnalysis { view: quiet.clone() }}>
                        <button
                            data-primary
                            disabled={analysis_active || screen.dashboard.overall.sku_count == 0}
                        >
                            "Queue fresh analysis"
                        </button>
                    </form>
                </div>
            </header>
            if !configured {
                <Notice tone={Tone::Info}>
                    "Configure the continuous-pricing seller key before loading inventory."
                </Notice>
            }
            if let Some(message) = said(&screen.view, t) {
                <Notice tone={Tone::Done}>{message}</Notice>
            }
            <Problem why={screen.problem.as_deref()} />
            if let Some(analysis) = &screen.analysis {
                <AnalysisStatus analysis={analysis} view={&quiet} t={t} visitor={screen.visitor} />
            }
            <PerformancePanel screen={screen} t={t} />
            <MarginTrendPanel trend={screen.margin_trend.as_ref()} t={t} />
            <LeversPanels screen={screen} t={t} />
            <VerdictPanel screen={screen} t={t} />
            <HurdleSweep screen={screen} t={t} />
            <TurnaroundPanel screen={screen} input={input} errors={errors} t={t} />
            <SellingHistoryPanel screen={screen} t={t} />
        </section>
    }
}

/// The latest analysis batch and where it stands; while it runs it is read again every few
/// seconds, and the screen is read again once it ends.
#[component(css = StrategyScreen)]
pub fn AnalysisStatus<'a>(
    analysis: &'a Analysis,
    view: &'a View,
    t: Msg,
    visitor: Visitor,
) -> impl Patch {
    let active = analysis.active();
    let tone = if active {
        Tone::Info
    } else if analysis.status == "failed" {
        Tone::Warning
    } else {
        Tone::Done
    };
    let again = active.then(|| {
        ReadAgain {
            after: ANALYSIS_EVERY,
        }
        .from(url::Analysis {
            batch: analysis.batch_number,
            view: view.clone(),
        })
    });
    html! {
        <div id={AnalysisStatusId}>
            <Notice tone={tone}>
                "Latest analysis: batch "{analysis.batch_number}" is "{&analysis.status}
                if let Some(at) = analysis.last_priced_at {
                    " \u{b7} completed "
                    {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                }
            </Notice>
        </div>
        {again}
    }
}

/// A figure: what it is, its value large, and what it means.
#[component(css = StrategyScreen)]
pub fn Stat<'a>(label: &'a str, value: &'a str, detail: &'a str) -> impl Render {
    html! {
        <div class={Stat}>
            <span class={muted()}>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
        </div>
    }
}

/// How a [`Chip`] reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mood {
    Good,
    Caution,
}

/// A short status beside a heading.
#[component(css = StrategyScreen)]
pub fn Chip<'a>(mood: Mood, label: &'a str) -> impl Render {
    html! {
        match mood {
            Mood::Good => <span class={(Chip, Good)}>{label}</span>,
            Mood::Caution => <span class={(Chip, Caution)}>{label}</span>,
        }
    }
}

/// What to change, once per performance window: the levers read the window shown.
#[component(css = StrategyScreen)]
fn LeversPanels<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let windows = screen.windows();
    html! {
        if windows.is_empty() {
            <super::performance_panel::Levers levers={&screen.levers(None)} t={t} />
        } else {
            for window in windows {
                <div class={Window} data-window={window.window_days}>
                    <super::performance_panel::Levers levers={&screen.levers(Some(window))} t={t} />
                </div>
            }
        }
    }
}
