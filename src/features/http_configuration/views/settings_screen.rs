use corten::{prelude::*, view::Id};

use crate::{
    features::http_configuration::{config::Domain, form::SettingsInput, url},
    theme::*,
    ui::{
        accordion::Accordion,
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{Card, CardContent, CardHeader},
        dialog::{Dialog, DialogFooter},
        field::{Field, FieldHintId},
        input::Input,
        switch::Switch,
    },
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct SettingsFormId;

#[derive(Id)]
struct CookieId;

#[derive(Id)]
struct UserAgentId;

#[derive(Id)]
struct IncreaseMultiplierId;

#[derive(Id)]
struct FloorStepMsId;

#[derive(Id)]
struct DecreaseAmountMsId;

#[derive(Id)]
struct SuccessThresholdId;

#[derive(Id)]
struct RequestDelayId<'a>(&'a str);

#[derive(Id)]
struct RateLimitCooldownId<'a>(&'a str);

#[derive(Id)]
struct MaxConcurrentId<'a>(&'a str);

#[derive(Id)]
struct MinDelayId<'a>(&'a str);

#[derive(Id)]
struct MaxDelayId<'a>(&'a str);

#[derive(Id)]
struct LearnedMinDelayId<'a>(&'a str);

#[derive(Id)]
struct ResetDialogId;

/// The screen: the settings form, and the reset behind a confirming dialog. It shares the form's
/// stylesheet.
#[component(css = SettingsForm)]
pub fn SettingsScreen<'a>(input: &'a SettingsInput, errors: &'a Errors) -> impl Render {
    html! {
        <section class={Screen}>
            <h1>"HTTP Configuration"</h1>
            <p class={(muted(), mb_4())}>
                "Configure HTTP client settings for TCGPlayer API requests. Changes are saved to the database."
            </p>
            <SettingsForm input={input} errors={errors} />
            <div class={Card {}}>
                <header class={CardHeader {}}>
                    <h2>"Reset Configuration"</h2>
                    <p>
                        "Reset all HTTP configuration settings back to their original default values. This will clear your saved auth cookie."
                    </p>
                </header>
                <div class={CardContent {}}>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        type="button"
                        command="show-modal"
                        commandfor={ResetDialogId}
                    >
                        "Reset to Defaults"
                    </button>
                </div>
            </div>
            <dialog
                class={Dialog {}}
                id={ResetDialogId}
                closedby="any"
                aria-labelledby="reset-dialog-title"
            >
                <h2 id="reset-dialog-title">"Reset to defaults?"</h2>
                <Alert variant={AlertVariant::Warning}>
                    <p>
                        "This clears the auth cookie and every rate limit. It cannot be undone."
                    </p>
                </Alert>
                <form method="post" action={url::ResetSettings}>
                    <div class={DialogFooter {}}>
                        <button
                            class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }}
                            type="button"
                            command="close"
                            commandfor={ResetDialogId}
                        >
                            "Cancel"
                        </button>
                        <button
                            class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}
                        >
                            "Confirm Reset"
                        </button>
                    </div>
                </form>
            </dialog>
        </section>
    }
}

/// The settings, one card per group. A domain's adaptive bounds show while its switch is on (CSS,
/// no script); they are sent either way, as the React app sent them.
#[component(css, js)]
pub fn SettingsForm<'a>(input: &'a SettingsInput, errors: &'a Errors) -> impl Patch {
    let (f, e) = (SettingsInput::FIELDS, errors.within(SettingsFormId));
    let cookie = refs();
    html! {
        <form
            id={SettingsFormId}
            class={Form}
            method="post"
            action={url::HttpSettings}
            data-patch
        >
            {errors.form_message()}
            <div class={Card {}}>
                <header class={CardHeader {}}><h2>"Authentication"</h2></header>
                <div class={CardContent {}}>
                    <Field
                        id={CookieId}
                        label="TCGPlayer Auth Cookie"
                        hint="Your TCGAuthTicket_Production cookie value (without the key name)"
                        error={e.message(f.tcg_auth_cookie)}
                    >
                        <input
                            class={Input {}}
                            id={CookieId}
                            ref={cookie}
                            type="password"
                            name={f.tcg_auth_cookie}
                            value={&input.tcg_auth_cookie}
                            autocomplete="off"
                            {..e.aria(f.tcg_auth_cookie).hint(&FieldHintId(&CookieId))}
                        >
                        <Switch label="Show">
                            <input
                                type="checkbox"
                                role="switch"
                                on:change={js::reveal(target, cookie)}
                            >
                        </Switch>
                    </Field>
                    <Alert variant={AlertVariant::Info}>
                        <strong>"To get your auth cookie:"</strong>
                        <ol>
                            <li>"Log in to TCGPlayer.com"</li>
                            <li>"Open browser DevTools (F12)"</li>
                            <li>"Go to Application/Storage → Cookies"</li>
                            <li>"Copy the value of TCGAuthTicket_Production"</li>
                        </ol>
                    </Alert>
                </div>
            </div>
            <div class={Card {}}>
                <header class={CardHeader {}}><h2>"Request Settings"</h2></header>
                <div class={CardContent {}}>
                    <Field
                        id={UserAgentId}
                        label="User Agent"
                        hint="Browser user agent string"
                        error={e.message(f.user_agent)}
                    >
                        <input
                            class={Input {}}
                            id={UserAgentId}
                            name={f.user_agent}
                            value={&input.user_agent}
                            {..e.aria(f.user_agent).hint(&FieldHintId(&UserAgentId))}
                        >
                    </Field>
                </div>
            </div>
            <div class={Card {}}>
                <header class={CardHeader {}}>
                    <h2>"Adaptive Algorithm Settings"</h2>
                    <p>
                        "Configure the AIMD (Additive Increase, Multiplicative Decrease) algorithm used for adaptive rate limiting. These settings apply globally to all domains with adaptive mode enabled."
                    </p>
                </header>
                <div class={CardContent {}}>
                    <Field
                        id={IncreaseMultiplierId}
                        label="Increase Multiplier"
                        hint="Multiply delay by this factor on rate limit (e.g., 2.0 = double)"
                        error={e.message(f.increase_multiplier)}
                    >
                        <input
                            class={Input {}}
                            id={IncreaseMultiplierId}
                            type="number"
                            min="1.1"
                            max="5"
                            step="0.1"
                            name={f.increase_multiplier}
                            value={&input.increase_multiplier}
                            {..e.aria(f.increase_multiplier).hint(&FieldHintId(&IncreaseMultiplierId))}
                        >
                    </Field>
                    <Field
                        id={FloorStepMsId}
                        label="Floor Step (ms)"
                        hint="Amount to raise the learned floor on each rate limit"
                        error={e.message(f.floor_step_ms)}
                    >
                        <input
                            class={Input {}}
                            id={FloorStepMsId}
                            type="number"
                            min="10"
                            step="10"
                            name={f.floor_step_ms}
                            value={&input.floor_step_ms}
                            {..e.aria(f.floor_step_ms).hint(&FieldHintId(&FloorStepMsId))}
                        >
                    </Field>
                    <Field
                        id={DecreaseAmountMsId}
                        label="Decrease Amount (ms)"
                        hint="Amount to decrease delay after a success streak"
                        error={e.message(f.decrease_amount_ms)}
                    >
                        <input
                            class={Input {}}
                            id={DecreaseAmountMsId}
                            type="number"
                            min="10"
                            step="10"
                            name={f.decrease_amount_ms}
                            value={&input.decrease_amount_ms}
                            {..e.aria(f.decrease_amount_ms).hint(&FieldHintId(&DecreaseAmountMsId))}
                        >
                    </Field>
                    <Field
                        id={SuccessThresholdId}
                        label="Success Threshold"
                        hint="Number of consecutive successes before decreasing delay"
                        error={e.message(f.success_threshold)}
                    >
                        <input
                            class={Input {}}
                            id={SuccessThresholdId}
                            type="number"
                            min="1"
                            step="1"
                            name={f.success_threshold}
                            value={&input.success_threshold}
                            {..e.aria(f.success_threshold).hint(&FieldHintId(&SuccessThresholdId))}
                        >
                    </Field>
                </div>
            </div>
            <div class={Card {}}>
                <header class={CardHeader {}}>
                    <h2>"Domain Rate Limits"</h2>
                    <p>
                        "Configure rate limiting settings for each TCGPlayer API domain. Each domain has its own isolated rate limiter, so hitting a rate limit on one domain won't affect requests to other domains."
                    </p>
                </header>
                <div class={(CardContent {}, Accordion {})}>
                    for (domain, row) in &input.domains {
                        let r = f.domains.at(domain);
                        let invalid = [r.request_delay_ms, r.rate_limit_cooldown_ms, r.max_concurrent_requests, r.min_request_delay_ms, r.max_request_delay_ms, r.learned_min_delay_ms].into_iter().any(|n| errors.has(n));
                        let key = domain.key();
                        <details class={DomainBox} open={invalid}>
                            <summary>
                                <span class={Title}>
                                    <strong>{domain.label()}</strong>
                                    <span class={AdaptiveBadge}>
                                        <span
                                            class={Badge { tone: BadgeTone::Primary, emphasis: BadgeEmphasis::Solid }}
                                        >
                                            "Adaptive"
                                        </span>
                                    </span>
                                </span>
                            </summary>
                            <div class={Settings}>
                                <Switch label="Enable Adaptive Rate Limiting">
                                    <input
                                        type="checkbox"
                                        role="switch"
                                        name={r.adaptive}
                                        checked={row.adaptive}
                                    >
                                </Switch>
                                <Field
                                    id={RequestDelayId(&key)}
                                    label="Request Delay (ms)"
                                    hint="Delay between consecutive requests (auto-adjusted when adaptive is enabled)"
                                    error={e.message(r.request_delay_ms)}
                                >
                                    <input
                                        class={Input {}}
                                        id={RequestDelayId(&key)}
                                        type="number"
                                        min="0"
                                        step="100"
                                        name={r.request_delay_ms}
                                        value={&row.request_delay_ms}
                                        {..e.aria(r.request_delay_ms).hint(&FieldHintId(&RequestDelayId(&key)))}
                                    >
                                </Field>
                                <Field
                                    id={RateLimitCooldownId(&key)}
                                    label="Rate Limit Cooldown (ms)"
                                    hint="Cooldown after 403/429 response"
                                    error={e.message(r.rate_limit_cooldown_ms)}
                                >
                                    <input
                                        class={Input {}}
                                        id={RateLimitCooldownId(&key)}
                                        type="number"
                                        min="0"
                                        step="1000"
                                        name={r.rate_limit_cooldown_ms}
                                        value={&row.rate_limit_cooldown_ms}
                                        {..e.aria(r.rate_limit_cooldown_ms).hint(&FieldHintId(&RateLimitCooldownId(&key)))}
                                    >
                                </Field>
                                <Field
                                    id={MaxConcurrentId(&key)}
                                    label="Max Concurrent Requests"
                                    hint="Maximum simultaneous requests to this domain"
                                    error={e.message(r.max_concurrent_requests)}
                                >
                                    <input
                                        class={Input {}}
                                        id={MaxConcurrentId(&key)}
                                        type="number"
                                        min="1"
                                        max="10"
                                        name={r.max_concurrent_requests}
                                        value={&row.max_concurrent_requests}
                                        {..e.aria(r.max_concurrent_requests).hint(&FieldHintId(&MaxConcurrentId(&key)))}
                                    >
                                </Field>
                                <fieldset class={Bounds}>
                                    <legend>"Adaptive Bounds"</legend>
                                    <Field
                                        id={MinDelayId(&key)}
                                        label="Min Request Delay (ms)"
                                        hint="Absolute minimum delay (starting point for probing)"
                                        error={e.message(r.min_request_delay_ms)}
                                    >
                                        <input
                                            class={Input {}}
                                            id={MinDelayId(&key)}
                                            type="number"
                                            min="0"
                                            step="50"
                                            name={r.min_request_delay_ms}
                                            value={&row.min_request_delay_ms}
                                            {..e.aria(r.min_request_delay_ms).hint(&FieldHintId(&MinDelayId(&key)))}
                                        >
                                    </Field>
                                    <Field
                                        id={MaxDelayId(&key)}
                                        label="Max Request Delay (ms)"
                                        hint="Maximum delay cap"
                                        error={e.message(r.max_request_delay_ms)}
                                    >
                                        <input
                                            class={Input {}}
                                            id={MaxDelayId(&key)}
                                            type="number"
                                            min="1000"
                                            step="1000"
                                            name={r.max_request_delay_ms}
                                            value={&row.max_request_delay_ms}
                                            {..e.aria(r.max_request_delay_ms).hint(&FieldHintId(&MaxDelayId(&key)))}
                                        >
                                    </Field>
                                    <Field
                                        id={LearnedMinDelayId(&key)}
                                        label="Learned Min Delay (ms)"
                                        hint="Runtime-learned floor (ratchets up on rate limits, reset by setting to Min Request Delay)"
                                        error={e.message(r.learned_min_delay_ms)}
                                    >
                                        <input
                                            class={Input {}}
                                            id={LearnedMinDelayId(&key)}
                                            type="number"
                                            min="0"
                                            step="100"
                                            name={r.learned_min_delay_ms}
                                            value={&row.learned_min_delay_ms}
                                            {..e.aria(r.learned_min_delay_ms).hint(&FieldHintId(&LearnedMinDelayId(&key)))}
                                        >
                                    </Field>
                                </fieldset>
                            </div>
                        </details>
                    }
                </div>
            </div>
            <div>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Save Configuration"
                </button>
            </div>
        </form>
    }
}

impl corten::view::AttrValue for Domain {
    fn write_attr(&self, name: &str, out: &mut String) {
        self.key().write_attr(name, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::http_configuration::config::HttpConfig;

    /// The screen is drawn with the design system's parts: a kit field's label names each
    /// control, a domain's fields have ids of their own, and the reset waits in a dialog.
    #[test]
    fn the_settings_are_drawn_with_the_design_system() {
        let input = SettingsInput::of(&HttpConfig::default());
        let html = SettingsScreen {
            input: &input,
            errors: &Errors::new(),
        }
        .to_html();
        let labels = crate::ui::assert_labels_name_their_controls(&html);
        assert_eq!(labels, 6 + 6 * Domain::ALL.len());
        assert!(html.contains("role=\"switch\""));
        assert!(html.contains("command=\"show-modal\""));
        assert!(!html.contains("data-primary"));
    }
}
