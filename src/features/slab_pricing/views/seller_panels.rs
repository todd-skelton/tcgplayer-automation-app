use corten::{
    ReadAgain,
    form::keep_query,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::{Number, NumberField, ordered};

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{MaintenanceInput, OutcomesInput},
            identity::words,
            maintenance::{FOLLOWING, View, range},
            page::{Place, Screen},
            url::{self, Choice},
            views::Problem,
        },
    },
    layout::Notice,
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        button::{Button, ButtonSize, ButtonVariant},
        checkbox::Checkbox,
        field::Field,
        input::Input,
        stepper::Stepper,
        textarea::Textarea,
    },
};

// These forms' answers carry no field errors: a refusal is the place's Problem. Their fields are
// named from the form's id through Within::none.
#[derive(Id)]
struct MaintenanceFormId;
#[derive(Id)]
struct OutcomeListingFormId;
#[derive(Id)]
struct ImportOutcomesFormId;

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
            <a
                on:connect={ordered::link(target, super::sorted_tables(), signal)}
                href={url::SlabPricing::at(&toggle_maintenance)}
            >
                if maintenance_shown { "Hide evidence maintenance" } else { "Evidence maintenance" }
            </a>
            <a
                on:connect={ordered::link(target, super::sorted_tables(), signal)}
                href={url::SlabPricing::at(&toggle_outcomes)}
            >
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
        <section class={(Panel, stack(Space::_3))} aria-labelledby="slab-maintenance">
            <h3 id="slab-maintenance">"Evidence maintenance · "{seller}</h3>
            <p class={muted()}>
                "Refresh confirmed inventory in small groups and update recommendations from fresh saved evidence. Reviewed price overrides stay in manual review. This never publishes prices."
            </p>
            if let Some(Err(why)) = &screen.maintenance {
                <Notice variant={AlertVariant::Warning}>{why}</Notice>
            }
            if let Some(view) = view {
                let e = Within::none(MaintenanceFormId);
                <form
                    on:submit={ordered::send(event, target, super::sorted_tables())}
                    id={MaintenanceFormId}
                    method="post"
                    action={url::SaveMaintenance { choice: choice.clone() }}
                    data-patch
                    class={stack(Space::_3)}
                >
                    <input type="hidden" name={f.revision} value={view.settings.revision}>
                    <div class={Line}>
                        <Checkbox label="Enable maintenance">
                            <input type="checkbox" name={f.enabled} checked={view.settings.enabled}>
                        </Checkbox>
                        <Checkbox label="Include active supply">
                            <input
                                type="checkbox"
                                name={f.include_supply}
                                checked={view.settings.include_supply}
                            >
                        </Checkbox>
                        <Field
                            id={e.id(f.interval_minutes)}
                            label="Refresh interval (minutes)"
                            hint=""
                            error=""
                        >
                            <Stepper>
                                <NumberField
                                    field={&Number {
                                        value: i64::from(view.settings.interval_minutes).into(),
                                        required: true,
                                        attrs: &e.aria(f.interval_minutes),
                                        ..Number::new(e.id(f.interval_minutes), f.interval_minutes, range::INTERVAL_MINUTES, "Fewer minutes", "More minutes")
                                    }}
                                />
                            </Stepper>
                        </Field>
                        <Field id={e.id(f.batch_size)} label="Listings per cycle" hint="" error="">
                            <Stepper>
                                <NumberField
                                    field={&Number {
                                        value: i64::from(view.settings.batch_size).into(),
                                        required: true,
                                        attrs: &e.aria(f.batch_size),
                                        ..Number::new(e.id(f.batch_size), f.batch_size, range::BATCH_SIZE, "Fewer listings", "More listings")
                                    }}
                                />
                            </Stepper>
                        </Field>
                        <Field
                            id={e.id(f.refresh_budget)}
                            label="Refresh jobs per cycle"
                            hint=""
                            error=""
                        >
                            <Stepper>
                                <NumberField
                                    field={&Number {
                                        value: i64::from(view.settings.refresh_budget).into(),
                                        required: true,
                                        attrs: &e.aria(f.refresh_budget),
                                        ..Number::new(e.id(f.refresh_budget), f.refresh_budget, range::REFRESH_BUDGET, "Fewer refresh jobs", "More refresh jobs")
                                    }}
                                />
                            </Stepper>
                        </Field>
                    </div>
                    <div class={Line}>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Save maintenance settings"
                        </button>
                        <a
                            on:connect={ordered::link(target, super::sorted_tables(), signal)}
                            href={url::SlabPricing::at(choice)}
                        >
                            "Reload status"
                        </a>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                            type="reset"
                        >
                            "Reset edits"
                        </button>
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
        <div id={MaintenanceStatusId} class={stack(Space::_3)} aria-live="polite">
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
        <Notice variant={AlertVariant::Info}>
            "Maintenance requires the existing slab evidence worker to be running."
        </Notice>
        if let Some(error) = &s.last_error {
            <Notice variant={AlertVariant::Warning}>{words(error)}</Notice>
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
        <Notice variant={AlertVariant::Info}>
            "Automatic publication is unavailable. Live seller access and adopted automation cohorts are required."
        </Notice>
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
        <section class={(Panel, stack(Space::_3))} aria-labelledby="slab-outcomes">
            <h3 id="slab-outcomes">"Seller outcomes · "{seller}</h3>
            <p class={muted()}>
                "Record reviewed sales, cancellations and relists for imported listings. Observations keep their first recorded time and source; repeated imports do not duplicate them. Conflicting claims remain unresolved. Inventory and prices are unchanged."
            </p>
            let e = Within::none(OutcomeListingFormId);
            <form
                on:submit={ordered::send(event, target, super::sorted_tables())}
                id={OutcomeListingFormId}
                method="get"
                action={url::SlabPricing::at(&Choice::default())}
                class={Line}
            >
                {keep_query(
                    &url::SlabPricing::at(choice),
                    html! {
                    <Field id={e.id(f.item)} label="Outcome listing item ID" hint="" error="">
                        <input class={Input {}} value={choice.item.as_deref().unwrap_or("")} required {..e.control(f.item)}>
                    </Field>
                    <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>"Read saved outcomes"</button>
                    },
                )}
            </form>
            <details>
                <summary>"Import reviewed outcomes"</summary>
                let o_e = Within::none(ImportOutcomesFormId);
                <form
                    on:submit={ordered::send(event, target, super::sorted_tables())}
                    id={ImportOutcomesFormId}
                    method="post"
                    action={url::ImportOutcomes { choice: choice.clone() }}
                    data-patch
                    class={stack(Space::_3)}
                >
                    <p class={muted()}>
                        "Paste up to 50 rows. Required columns: event_id, item_id, kind, occurred_at, quantity, note. Use sale, cancellation or relist; quantity must be 1. Use a UTC time such as 2026-09-01T12:00:00Z. Optional sale columns: price, currency (item price only). Cancellations require related_sale_id; relists require next_item_id. Use a stable event ID and a note describing the evidence. Import each original listing into this seller's inventory first."
                    </p>
                    <Field id={o_e.id(o.csv)} label="Seller outcome CSV" hint="" error="">
                        <textarea class={Textarea {}} rows="4" required {..o_e.control(o.csv)}></textarea>
                    </Field>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Save reviewed outcomes"
                    </button>
                </form>
            </details>
            <Problem at={Place::Outcomes} why={screen.problem_at(Place::Outcomes)} />
            match &screen.outcomes {
                None => {}
                Some(Err(why)) => <Notice variant={AlertVariant::Warning}>{why}</Notice>,
                Some(Ok(review)) => {
                    <p>
                        "Listing "{&review.item_id}": "{review.summary.sales}
                        " uncancelled sale records · "
                        {review.summary.cancellations}" cancellation records · "
                        {review.summary.relists}" relist records."
                    </p>
                    if !review.summary.unresolved.is_empty() {
                        <Notice variant={AlertVariant::Warning}>
                            "Unresolved event IDs: "{review.summary.unresolved.join(", ")}
                            ". Conflicting or unlinked observations are excluded from usable sales."
                        </Notice>
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
