use std::time::Duration;

use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::ShownFor;

use super::{
    margin_trend::MarginTrendPanel,
    performance_panel::PerformancePanel,
    selling_history_panel::SellingHistoryPanel,
    turnaround_panel::TurnaroundPanel,
    verdict_panel::{HurdleSweep, VerdictPanel},
};
use crate::{
    features::inventory_strategy::{
        performance::RealizedWindow,
        realized::Realized,
        screen::{Analysis, Screen, SellingHistory, Turnaround},
        url::{self, View},
    },
    layout::Notice,
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardPanel, CardSize},
    },
};

/// How often a running analysis is read again.
pub const ANALYSIS_EVERY: Duration = Duration::from_secs(5);

#[derive(Id)]
struct StrategyProblemId;

#[derive(Id)]
pub struct AnalysisStatusId;

/// The screen's id: an analysis that ends replaces the whole screen with its results.
#[derive(Id)]
pub struct StrategyScreenId;

/// Each slow part's id: its stream's fragment, or a scope's patch, replaces it.
#[derive(Id)]
pub struct RealizedPartId;
#[derive(Id)]
pub struct PolicyPartId;
#[derive(Id)]
pub struct TurnaroundPartId;
#[derive(Id)]
pub struct SellingHistoryPartId;

/// Why the last post was refused, announced where the actions are.
#[component(css = StrategyScreen)]
pub fn Problem<'a>(why: Option<&'a str>) -> impl Patch {
    html! {
        <div id={StrategyProblemId}>
            if let Some(why) = why {
                <Notice variant={AlertVariant::Warning}>{why}</Notice>
            }
        </div>
    }
}

/// How the pricing strategy is doing and what to change, top to bottom.
#[component(css)]
pub fn StrategyScreen<'a>(screen: &'a Screen, t: Msg) -> impl Patch {
    let quiet = screen.view.clone();
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
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                            disabled={!configured}
                        >
                            "Refresh inventory"
                        </button>
                    </form>
                    <form method="post" action={url::QueueAnalysis { view: quiet.clone() }}>
                        <button
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            disabled={analysis_active || screen.dashboard.overall.sku_count == 0}
                        >
                            "Queue fresh analysis"
                        </button>
                    </form>
                </div>
            </header>
            if !configured {
                <Notice variant={AlertVariant::Info}>
                    "Configure the continuous-pricing seller key before loading inventory."
                </Notice>
            }
            <Problem why={screen.problem.as_deref()} />
            if let Some(analysis) = &screen.analysis {
                <AnalysisStatus analysis={analysis} view={&quiet} t={t} />
            }
            if screen.realized.is_some() {
                <Returns screen={screen} t={t} />
            } else {
                <corten-live src={url::ReturnsLive { view: quiet.clone() }}>
                    <Returns screen={screen} t={t} />
                </corten-live>
            }
            match &screen.selling_history {
                Some(history) => <SellingHistoryPart history={Some(history)} view={&quiet} t={t} />,
                None => {
                    <corten-live src={url::SellingHistoryLive { view: quiet.clone() }}>
                        <SellingHistoryPart history={None} view={&quiet} t={t} />
                    </corten-live>
                }
            }
        </section>
    }
}

/// What the selling earned, what to change and the policy's verdict, the hurdle sweep and the
/// capital turnaround, top to bottom; the parts not read in wait for the
/// stream.
#[component(css = StrategyScreen)]
fn Returns<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let (realized, turnaround) = (screen.realized.as_ref(), screen.turnaround.as_ref());
    html! {
        <RealizedPart screen={screen} realized={realized} t={t} />
        <PolicyPart screen={screen} realized={realized} turnaround={turnaround} t={t} />
        <HurdleSweep screen={screen} t={t} />
        <TurnaroundPart screen={screen} turnaround={turnaround} t={t} />
    }
}

/// A part on its way: its heading, that it is being read and, where no stream will bring it
/// (no JavaScript, or a stream that gave up), a link to the page with every part read in.
#[component(css = StrategyScreen)]
fn Waiting<'a>(title: &'a str, view: &'a View) -> impl Render {
    let whole = url::InventoryStrategy { view: view.whole() };
    html! {
        <section class={CardPanel { size: CardSize::Sm }}>
            <h2>{title}</h2>
            <p class={muted()} role="status">
                <span class={Reading}>"Reading\u{2026}"</span>
                <a class={ShowNow} href={&whole} rel="nofollow">"Show "{title.to_lowercase()}</a>
            </p>
        </section>
    }
}

/// Realized performance and the margin over time.
#[component(css = StrategyScreen)]
pub fn RealizedPart<'a>(screen: &'a Screen, realized: Option<&'a Realized>, t: Msg) -> impl Patch {
    html! {
        <div id={RealizedPartId} class={Part}>
            match realized {
                Some(realized) => {
                    <PerformancePanel screen={screen} realized={realized} t={t} />
                    <MarginTrendPanel trend={realized.margin_trend.as_ref()} t={t} />
                }
                None => <Waiting title="Realized performance" view={&screen.view} />,
            }
        </div>
    }
}

/// What to change and the active policy's verdict: both weigh the capital turnaround, and the
/// levers realized performance too.
#[component(css = StrategyScreen)]
pub fn PolicyPart<'a>(
    screen: &'a Screen,
    realized: Option<&'a Realized>,
    turnaround: Option<&'a Turnaround>,
    t: Msg,
) -> impl Patch {
    html! {
        <div id={PolicyPartId} class={Part}>
            match (realized, turnaround) {
                (Some(realized), Some(turnaround)) => {
                    <LeversPanels
                        screen={screen}
                        realized={realized}
                        turnaround={turnaround}
                        t={t}
                    />
                    <VerdictPanel screen={screen} turnaround={turnaround} t={t} />
                }
                _ => <Waiting title="Active policy" view={&screen.view} />,
            }
        </div>
    }
}

/// The capital turnaround and its form.
#[component(css = StrategyScreen)]
pub fn TurnaroundPart<'a>(
    screen: &'a Screen,
    turnaround: Option<&'a Turnaround>,
    t: Msg,
) -> impl Patch {
    let none = Errors::new();
    html! {
        <div id={TurnaroundPartId} class={Part}>
            match turnaround {
                Some(turnaround) => {
                    let input = screen.turnaround_input(turnaround);
                    let errors = screen.refused_turnaround.as_ref().map_or(&none, |(_, e)| e);
                    <TurnaroundPanel
                        view={&screen.view}
                        turnaround={turnaround}
                        input={&input}
                        errors={errors}
                        t={t}
                    />
                }
                None => <Waiting title="Capital turnaround" view={&screen.view} />,
            }
        </div>
    }
}

/// The selling history over the view's scope; its scope form answers with this part alone.
#[component(css = StrategyScreen)]
pub fn SellingHistoryPart<'a>(
    history: Option<&'a SellingHistory>,
    view: &'a View,
    t: Msg,
) -> impl Patch {
    html! {
        <div id={SellingHistoryPartId} class={Part}>
            match history {
                Some(history) => <SellingHistoryPanel history={history} t={t} />,
                None => <Waiting title="Selling history" view={view} />,
            }
        </div>
    }
}

/// The latest analysis batch and where it stands; while it runs it is read again every few
/// seconds, and the screen is read again once it ends.
#[component(css = StrategyScreen)]
pub fn AnalysisStatus<'a>(analysis: &'a Analysis, view: &'a View, t: Msg) -> impl Patch {
    let active = analysis.active();
    let tone = if active {
        AlertVariant::Info
    } else if analysis.status == "failed" {
        AlertVariant::Warning
    } else {
        AlertVariant::Success
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
            <Notice variant={tone}>
                "Latest analysis: batch "{analysis.batch_number}" is "{&analysis.status}
                if let Some(at) = analysis.last_priced_at {
                    " \u{b7} completed "
                    {t.date_time(at, DateStyle::Short, TimeStyle::Medium)}
                }
            </Notice>
        </div>
        {again}
    }
}

/// What to change, once per performance window: the levers read the window shown.
#[component(css = StrategyScreen)]
fn LeversPanels<'a>(
    screen: &'a Screen,
    realized: &'a Realized,
    turnaround: &'a Turnaround,
    t: Msg,
) -> impl Render {
    let windows = realized.windows();
    let choice = super::performance_panel::realized_choice(screen);
    html! {
        if windows.is_empty() {
            <super::performance_panel::Levers levers={&screen.levers(turnaround, None)} t={t} />
        } else {
            for (window, shown) in windows.iter().filter_map(|w| Some((w, RealizedWindow::of(w.window_days)?))) {
                <ShownFor choice={&choice} values={&[shown]}>
                    <super::performance_panel::Levers
                        levers={&screen.levers(turnaround, Some(window))}
                        t={t}
                    />
                </ShownFor>
            }
        }
    }
}
