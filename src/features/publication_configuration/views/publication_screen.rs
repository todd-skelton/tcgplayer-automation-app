use corten::prelude::*;

use crate::{
    features::publication_configuration::{
        config::{Authentication, Runtime, Source},
        form::SettingsInput,
        url,
    },
    layout::LabeledControl,
    theme::*,
    ui::alert::{Alert, AlertVariant},
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct PublicationFormId;

/// The screen: what the last post did, and the form. It shares the form's stylesheet.
#[component(css = PublicationForm)]
pub fn PublicationScreen<'a>(
    input: &'a SettingsInput,
    runtime: &'a Runtime,
    errors: &'a Errors,
) -> impl Render {
    html! {
        <section>
            <h1>"Inventory Publication"</h1>
            <p class={(muted(), mb_4())}>
                "Automatic publication uses durable staged imports. It is disabled by default, never automatically replays ambiguous outcomes, and keeps quantity deltas separate from continuous price-only work."
            </p>
            <PublicationForm input={input} runtime={runtime} errors={errors} />
        </section>
    }
}

/// The publisher's state and the settings. Resume is a button of the same form that posts to its
/// own route, which saves nothing.
#[component(css)]
pub fn PublicationForm<'a>(
    input: &'a SettingsInput,
    runtime: &'a Runtime,
    errors: &'a Errors,
) -> impl Patch {
    let (f, e) = (SettingsInput::FIELDS, errors.within(PublicationFormId));
    let state = html! {
        "Authentication: "{runtime.authentication.word()}". Circuit: "
        {if runtime.circuit_open { "paused" } else { "ready" }}
        ". Consecutive failures: "{runtime.consecutive_failures}"."
        match &runtime.pause_reason {
            Some(reason) => { " "{reason} }
            None => {}
        }
    };
    html! {
        <form
            id={PublicationFormId}
            method="post"
            action={url::PublicationSettings}
            data-patch
        >
            {errors.form_message()}
            <section class={(panel(), mb_4())}>
                <div class={PanelBody}>
                    <h2>"Runtime safety"</h2>
                    if runtime.needs_resume() {
                        <Alert variant={AlertVariant::Warning}>{state}</Alert>
                    } else if runtime.authentication == Authentication::Healthy {
                        <Alert variant={AlertVariant::Success}>{state}</Alert>
                    } else {
                        <Alert variant={AlertVariant::Info}>{state}</Alert>
                    }
                    <label class={Switch}>
                        <input type="checkbox" name={f.global_paused} checked={input.global_paused}>
                        "Global publication pause"
                    </label>
                    if runtime.needs_resume() {
                        <div>
                            <button formaction={url::ResumePublication}>
                                "Resume after authentication is refreshed"
                            </button>
                        </div>
                    }
                </div>
            </section>
            <section class={(panel(), mb_4())}>
                <div class={PanelBody}>
                    <h2>"Automatic publication"</h2>
                    <label class={Switch}>
                        <input
                            type="checkbox"
                            name={f.automatic_publishing_enabled}
                            checked={input.automatic_publishing_enabled}
                        >
                        "Enable automatic publication globally"
                    </label>
                    <fieldset class={Sources}>
                        <legend class={muted()}>"Sources that publish automatically"</legend>
                        for source in Source::ALL {
                            <label class={Switch}>
                                <input
                                    type="checkbox"
                                    name={f.automatic_sources}
                                    value={source}
                                    checked={input.automatic_sources.contains(&source)}
                                >
                                {source.label()}
                            </label>
                        }
                    </fieldset>
                </div>
            </section>
            <section class={(panel(), mb_4())}>
                <div class={PanelBody}>
                    <h2>"Guardrails"</h2>
                    <div class={Numbers}>
                        <LabeledControl label="Failure limit" hint="">
                            <input
                                type="number"
                                min="1"
                                max="100"
                                name={f.consecutive_failure_limit}
                                value={&input.consecutive_failure_limit}
                                {..e.aria(f.consecutive_failure_limit)}
                            >
                            {e.message(f.consecutive_failure_limit)}
                        </LabeledControl>
                        <LabeledControl label="Minimum price change ($)" hint="">
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                name={f.minimum_absolute_price_change}
                                value={&input.minimum_absolute_price_change}
                                {..e.aria(f.minimum_absolute_price_change)}
                            >
                            {e.message(f.minimum_absolute_price_change)}
                        </LabeledControl>
                        <LabeledControl label="Candidate maximum age (minutes)" hint="">
                            <input
                                type="number"
                                min="1"
                                max="10080"
                                name={f.maximum_candidate_age_minutes}
                                value={&input.maximum_candidate_age_minutes}
                                {..e.aria(f.maximum_candidate_age_minutes)}
                            >
                            {e.message(f.maximum_candidate_age_minutes)}
                        </LabeledControl>
                        <LabeledControl label="Staged micro-batch maximum" hint="">
                            <input
                                type="number"
                                min="1"
                                max="750"
                                name={f.staged_micro_batch_maximum}
                                value={&input.staged_micro_batch_maximum}
                                {..e.aria(f.staged_micro_batch_maximum)}
                            >
                            {e.message(f.staged_micro_batch_maximum)}
                        </LabeledControl>
                    </div>
                    <label class={Switch}>
                        <input
                            type="checkbox"
                            name={f.allow_warnings}
                            checked={input.allow_warnings}
                        >
                        "Allow pricing warnings to publish automatically"
                    </label>
                    <small class={muted()}>
                        "When off, a warned price still publishes if it was forecast from the curve, anchored by a market price, and profitable. Fallback and reference prices wait for review."
                    </small>
                </div>
            </section>
            <Alert variant={AlertVariant::Warning}>
                "Quantity values are additive in staged imports. CSV quantity deltas are always excluded from automatic publication. Once an inventory delta is planned, it cannot be recreated under another pricing candidate."
            </Alert>
            <button data-primary>"Save publication settings"</button>
        </form>
    }
}
