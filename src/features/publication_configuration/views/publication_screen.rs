use corten::prelude::*;

use crate::{
    features::publication_configuration::{
        config::{Authentication, Runtime, Source, range},
        form::SettingsInput,
        url,
    },
    layout::Notice,
    theme::*,
    ui::{
        alert::AlertVariant,
        button::{Button, ButtonSize, ButtonVariant},
        card::{Card, CardContent, CardHeader},
        checkbox::Checkbox,
        field::Field,
        input::Input,
        switch::Switch,
    },
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct PublicationFormId;

#[derive(Id)]
struct WarningsHintId;

#[derive(Id)]
struct FailureLimitId;

#[derive(Id)]
struct MinimumPriceChangeId;

#[derive(Id)]
struct CandidateMaximumAgeId;

#[derive(Id)]
struct StagedMicroBatchMaximumId;

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

/// The publisher's state and the settings, one card each. Resume is a button of the same form
/// that posts to its own route, which saves nothing.
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
            class={PublicationForm}
            method="post"
            action={url::PublicationSettings}
            data-patch
        >
            {errors.form_message()}
            <div class={Card {}}>
                <header class={CardHeader {}}><h2>"Runtime safety"</h2></header>
                <div class={CardContent {}}>
                    if runtime.needs_resume() {
                        <Notice variant={AlertVariant::Warning}><p>{state}</p></Notice>
                    } else if runtime.authentication == Authentication::Healthy {
                        <Notice variant={AlertVariant::Success}><p>{state}</p></Notice>
                    } else {
                        <Notice variant={AlertVariant::Info}><p>{state}</p></Notice>
                    }
                    <Switch label="Global publication pause">
                        <input
                            type="checkbox"
                            role="switch"
                            name={f.global_paused}
                            checked={input.global_paused}
                        >
                    </Switch>
                    if runtime.needs_resume() {
                        <div>
                            <button
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                                formaction={url::ResumePublication}
                            >
                                "Resume after authentication is refreshed"
                            </button>
                        </div>
                    }
                </div>
            </div>
            <div class={Card {}}>
                <header class={CardHeader {}}><h2>"Automatic publication"</h2></header>
                <div class={CardContent {}}>
                    <Switch label="Enable automatic publication globally">
                        <input
                            type="checkbox"
                            role="switch"
                            name={f.automatic_publishing_enabled}
                            checked={input.automatic_publishing_enabled}
                        >
                    </Switch>
                    <fieldset class={Sources}>
                        <legend>"Sources that publish automatically"</legend>
                        for source in Source::ALL {
                            <Checkbox label={source.label()}>
                                <input
                                    type="checkbox"
                                    name={f.automatic_sources}
                                    value={source}
                                    checked={input.automatic_sources.contains(&source)}
                                >
                            </Checkbox>
                        }
                    </fieldset>
                </div>
            </div>
            <div class={Card {}}>
                <header class={CardHeader {}}><h2>"Guardrails"</h2></header>
                <div class={CardContent {}}>
                    <div class={Numbers}>
                        <Field
                            id={FailureLimitId}
                            label="Failure limit"
                            hint=""
                            error={e.message(f.consecutive_failure_limit)}
                        >
                            <input
                                class={Input {}}
                                id={FailureLimitId}
                                type="number"
                                {..range::FAILURE_LIMIT}
                                name={f.consecutive_failure_limit}
                                value={&input.consecutive_failure_limit}
                                {..e.aria(f.consecutive_failure_limit)}
                            >
                        </Field>
                        <Field
                            id={MinimumPriceChangeId}
                            label="Minimum price change ($)"
                            hint=""
                            error={e.message(f.minimum_absolute_price_change)}
                        >
                            <input
                                class={Input {}}
                                id={MinimumPriceChangeId}
                                type="number"
                                {..range::PRICE_CHANGE}
                                name={f.minimum_absolute_price_change}
                                value={&input.minimum_absolute_price_change}
                                {..e.aria(f.minimum_absolute_price_change)}
                            >
                        </Field>
                        <Field
                            id={CandidateMaximumAgeId}
                            label="Candidate maximum age (minutes)"
                            hint=""
                            error={e.message(f.maximum_candidate_age_minutes)}
                        >
                            <input
                                class={Input {}}
                                id={CandidateMaximumAgeId}
                                type="number"
                                {..range::CANDIDATE_AGE_MINUTES}
                                name={f.maximum_candidate_age_minutes}
                                value={&input.maximum_candidate_age_minutes}
                                {..e.aria(f.maximum_candidate_age_minutes)}
                            >
                        </Field>
                        <Field
                            id={StagedMicroBatchMaximumId}
                            label="Staged micro-batch maximum"
                            hint=""
                            error={e.message(f.staged_micro_batch_maximum)}
                        >
                            <input
                                class={Input {}}
                                id={StagedMicroBatchMaximumId}
                                type="number"
                                {..range::MICRO_BATCH}
                                name={f.staged_micro_batch_maximum}
                                value={&input.staged_micro_batch_maximum}
                                {..e.aria(f.staged_micro_batch_maximum)}
                            >
                        </Field>
                    </div>
                    <div class={Warnings}>
                        <Switch label="Allow pricing warnings to publish automatically">
                            <input
                                type="checkbox"
                                role="switch"
                                name={f.allow_warnings}
                                checked={input.allow_warnings}
                                aria-describedby={WarningsHintId}
                            >
                        </Switch>
                        <small id={WarningsHintId} class={muted()}>
                            "When off, a warned price still publishes if it was forecast from the curve, anchored by a market price, and profitable. Fallback and reference prices wait for review."
                        </small>
                    </div>
                </div>
            </div>
            <Notice variant={AlertVariant::Warning}>
                <p>
                    "Quantity values are additive in staged imports. CSV quantity deltas are always excluded from automatic publication. Once an inventory delta is planned, it cannot be recreated under another pricing candidate."
                </p>
            </Notice>
            <div>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Save publication settings"
                </button>
            </div>
        </form>
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::publication_configuration::config::Settings;

    /// The settings are drawn with the design system's parts, each label naming its control, and
    /// the resume button shows only while the publisher waits for it.
    #[test]
    fn the_settings_are_drawn_with_the_design_system() {
        let input = SettingsInput::of(&Settings::default());
        for (circuit_open, resumes) in [(false, 0), (true, 1)] {
            let runtime = Runtime {
                authentication: Authentication::Healthy,
                circuit_open,
                consecutive_failures: 0,
                pause_reason: None,
            };
            let html = PublicationScreen {
                input: &input,
                runtime: &runtime,
                errors: &Errors::new(),
            }
            .to_html();
            assert_eq!(crate::ui::assert_labels_name_their_controls(&html), 4);
            assert_eq!(html.matches("role=\"switch\"").count(), 3);
            assert_eq!(html.matches("Resume after authentication").count(), resumes);
            assert!(!html.contains("data-primary"));
        }
    }
}
