use corten::{
    ReadAgain,
    form::keep_query,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{MaintenanceInput, OutcomesInput},
            identity::words,
            maintenance::{FOLLOWING, View},
            page::{Place, Screen},
            url::{self, Choice},
            views::Problem,
        },
    },
    layout::LabeledControl,
    text::Msg,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        button::{Button, ButtonSize, ButtonVariant},
    },
};

#[derive(Id)]
struct MaintenanceStatusId;

/// The seller's evidence maintenance and outcomes, each shown on request.
#[component(css = super::slab_screen::SlabScreen)]
pub fn SellerPanels<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let maintenance_shown = choice.maintenance == Some(true);
    let outcomes_shown = choice.outcomes == Some(true);
    let toggle_maintenance = Choice {
        maintenance: (!maintenance_shown).then_some(true),
        ..choice.clone()
    };
    let toggle_outcomes = Choice {
        outcomes: (!outcomes_shown).then_some(true),
        item: None,
        ..choice.clone()
    };
    html! {
        <div class={(Line, SellerPanels)}>
            <a href={url::SlabPricing::at(&toggle_maintenance)}>
                if maintenance_shown { "Hide evidence maintenance" } else { "Evidence maintenance" }
            </a>
            <a href={url::SlabPricing::at(&toggle_outcomes)}>
                if outcomes_shown { "Hide seller outcomes" } else { "Seller outcomes" }
            </a>
        </div>
        if maintenance_shown {
            <MaintenancePanel screen={screen} t={t} />
        }
        if outcomes_shown {
            <OutcomesPanel screen={screen} />
        }
    }
}

/// The seller's maintenance settings and how its cycles went. Never publishes prices.
#[component(css = super::slab_screen::SlabScreen)]
fn MaintenancePanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let seller = choice.seller.as_deref().unwrap_or("");
    let f = MaintenanceInput::FIELDS;
    let view = screen.maintenance.as_ref().and_then(|m| m.as_ref().ok());
    html! {
        <section class={(Panel, Stack)} aria-labelledby="slab-maintenance">
            <h3 id="slab-maintenance">"Evidence maintenance · "{seller}</h3>
            <p class={muted()}>
                "Refresh confirmed inventory in small groups and update recommendations from fresh saved evidence. Reviewed price overrides stay in manual review. This never publishes prices."
            </p>
            if let Some(Err(why)) = &screen.maintenance {
                <Alert variant={AlertVariant::Warning}>{why}</Alert>
            }
            if let Some(view) = view {
                <form
                    method="post"
                    action={url::SaveMaintenance { choice: choice.clone() }}
                    data-patch
                    class={Stack}
                >
                    <input type="hidden" name={f.revision} value={view.settings.revision}>
                    <div class={Line}>
                        <label class={Check}>
                            <input type="checkbox" name={f.enabled} checked={view.settings.enabled}>
                            "Enable maintenance"
                        </label>
                        <label class={Check}>
                            <input
                                type="checkbox"
                                name={f.include_supply}
                                checked={view.settings.include_supply}
                            >
                            "Include active supply"
                        </label>
                        <LabeledControl label="Refresh interval (minutes)" hint="">
                            <input
                                type="number"
                                name={f.interval_minutes}
                                value={view.settings.interval_minutes}
                                min="15"
                                max="1440"
                                step="1"
                                required
                            >
                        </LabeledControl>
                        <LabeledControl label="Listings per cycle" hint="">
                            <input
                                type="number"
                                name={f.batch_size}
                                value={view.settings.batch_size}
                                min="1"
                                max="25"
                                step="1"
                                required
                            >
                        </LabeledControl>
                        <LabeledControl label="Refresh jobs per cycle" hint="">
                            <input
                                type="number"
                                name={f.refresh_budget}
                                value={view.settings.refresh_budget}
                                min="1"
                                max="50"
                                step="1"
                                required
                            >
                        </LabeledControl>
                    </div>
                    <div class={Line}>
                        <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                            <button>"Save maintenance settings"</button>
                        </Button>
                        <a href={url::SlabPricing::at(choice)}>"Reload status"</a>
                        <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                            <button type="reset">"Reset edits"</button>
                        </Button>
                    </div>
                </form>
            }
            <Problem at={Place::Maintenance} why={screen.problem_at(Place::Maintenance)} />
            <MaintenanceStatusPart screen={screen} t={t} />
        </section>
    }
}

/// How the seller's cycles went and the connections they use. Read again every five seconds
/// while maintenance is enabled.
#[component(css = super::slab_screen::SlabScreen)]
pub fn MaintenanceStatusPart<'a>(screen: &'a Screen, t: Msg) -> impl Patch {
    let view = screen.maintenance.as_ref().and_then(|m| m.as_ref().ok());
    let following = view.is_some_and(|v| v.settings.enabled);
    let from = url::MaintenanceStatus {
        choice: screen.choice.clone(),
    };
    html! {
        <div id={MaintenanceStatusId} class={Stack} aria-live="polite">
            if let Some(view) = view {
                <MaintenanceStatusLines view={view} t={t} />
            }
        </div>
        if following {
            {ReadAgain { after: FOLLOWING }.from(&from)}
        }
    }
}

#[component(css = super::slab_screen::SlabScreen)]
fn MaintenanceStatusLines<'a>(view: &'a View, t: Msg) -> impl Render {
    let s = &view.settings;
    let last = s.last_cycle_at;
    let next = s.next_cycle_at.filter(|_| s.enabled);
    let providers = view
        .providers
        .iter()
        .map(|p| format!("{}: {}", p.provider.as_ref(), words(p.status.as_ref())))
        .collect::<Vec<_>>()
        .join(" · ");
    html! {
        <p>
            if s.enabled { "Enabled" } else { "Paused" }
            " · Last cycle: "
            match last {
                Some(last) => {
                    {t.date_time(last, DateStyle::Short, TimeStyle::Medium)}
                }
                None => "Not run",
            }
        </p>
        <p class={muted()}>
            "Next worker check: "
            match next {
                Some(next) => {
                    {t.date_time(next, DateStyle::Short, TimeStyle::Medium)}
                }
                None => "Paused",
            }
            ". Turning maintenance off stops further work; already requested evidence and an in-progress calculation may finish."
        </p>
        <Alert variant={AlertVariant::Info}>
            "Maintenance requires the existing slab evidence worker to be running."
        </Alert>
        if let Some(error) = &s.last_error {
            <Alert variant={AlertVariant::Warning}>{words(error)}</Alert>
        }
        if let Some(summary) = &s.last_summary {
            <p class={muted()}>
                "Last cycle: "{summary.checked}" listings checked · "{summary.queued}
                " queued source jobs · "{summary.recalculated}" recalculated · "{summary.held}
                " held for review."
            </p>
        }
        <p class={muted()}>
            "Connections: "{providers}". "
            <a href={slab_connections::url::SlabConnections}>"Manage connections"</a>
        </p>
        <Alert variant={AlertVariant::Info}>
            "Automatic publication is unavailable. Live seller access and adopted automation cohorts are required."
        </Alert>
        <details>
            <summary>"Recent listing checks"</summary>
            for item in &view.items {
                <p class={muted()} key={&item.id}>
                    {item.title.as_deref().unwrap_or(&item.id)}": "{words(&item.outcome)}" · "
                    {words(&item.reason)}
                </p>
            }
            if view.items.is_empty() {
                <p class={muted()}>"No listing checks yet."</p>
            }
        </details>
    }
}

/// Reviewed sales, cancellations and relists for one of the seller's listings, and importing
/// more. Inventory and prices are unchanged.
#[component(css = super::slab_screen::SlabScreen)]
fn OutcomesPanel<'a>(screen: &'a Screen) -> impl Render {
    let choice = &screen.choice;
    let seller = choice.seller.as_deref().unwrap_or("");
    let f = Choice::FIELDS;
    let o = OutcomesInput::FIELDS;
    html! {
        <section class={(Panel, Stack)} aria-labelledby="slab-outcomes">
            <h3 id="slab-outcomes">"Seller outcomes · "{seller}</h3>
            <p class={muted()}>
                "Record reviewed sales, cancellations and relists for imported listings. Observations keep their first recorded time and source; repeated imports do not duplicate them. Conflicting claims remain unresolved. Inventory and prices are unchanged."
            </p>
            <form method="get" action={url::SlabPricing::at(&Choice::default())} class={Line}>
                {keep_query(
                    &url::SlabPricing::at(choice),
                    html! {
                    <LabeledControl label="Outcome listing item ID" hint="">
                        <input name={f.item} value={choice.item.as_deref().unwrap_or("")} required>
                    </LabeledControl>
                    <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                        <button>"Read saved outcomes"</button>
                    </Button>
                    },
                )}
            </form>
            <details>
                <summary>"Import reviewed outcomes"</summary>
                <form
                    method="post"
                    action={url::ImportOutcomes { choice: choice.clone() }}
                    data-patch
                    class={Stack}
                >
                    <p class={muted()}>
                        "Paste up to 50 rows. Required columns: event_id, item_id, kind, occurred_at, quantity, note. Use sale, cancellation or relist; quantity must be 1. Use a UTC time such as 2026-09-01T12:00:00Z. Optional sale columns: price, currency (item price only). Cancellations require related_sale_id; relists require next_item_id. Use a stable event ID and a note describing the evidence. Import each original listing into this seller's inventory first."
                    </p>
                    <LabeledControl label="Seller outcome CSV" hint="">
                        <textarea name={o.csv} rows="4" required></textarea>
                    </LabeledControl>
                    <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                        <button>"Save reviewed outcomes"</button>
                    </Button>
                </form>
            </details>
            <Problem at={Place::Outcomes} why={screen.problem_at(Place::Outcomes)} />
            match &screen.outcomes {
                None => {}
                Some(Err(why)) => <Alert variant={AlertVariant::Warning}>{why}</Alert>,
                Some(Ok(review)) => {
                    <p>
                        "Listing "{&review.item_id}": "{review.summary.sales}
                        " uncancelled sale records · "
                        {review.summary.cancellations}" cancellation records · "
                        {review.summary.relists}" relist records."
                    </p>
                    if !review.summary.unresolved.is_empty() {
                        <Alert variant={AlertVariant::Warning}>
                            "Unresolved event IDs: "{review.summary.unresolved.join(", ")}
                            ". Conflicting or unlinked observations are excluded from usable sales."
                        </Alert>
                    }
                    <p class={muted()}>
                        "Manually reviewed observations only; seller order access is not connected. This is incomplete history, and does not establish continuous exposure, sale probability or time to sell."
                    </p>
                    <details>
                        <summary>"Observation details ("{review.observations.len()}")"</summary>
                        for row in &review.observations {
                            <p class={(muted(), Wrap)}>{row.line()}</p>
                        }
                    </details>
                }
            }
        </section>
    }
}
