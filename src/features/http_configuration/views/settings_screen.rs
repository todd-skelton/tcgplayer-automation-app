use corten::{prelude::*, view::Id};

use crate::{
    features::http_configuration::{form::SettingsInput, url},
    layout::{FormNotice, Notice},
    theme::*,
    ui::{
        accordion::Accordion,
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{Card, CardContent, CardHeader, CardSize},
        dialog::{Dialog, DialogFooter, DialogSize},
        field::Field,
        input::Input,
        input_group::InputGroup,
        switch::Switch,
    },
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct SettingsFormId;

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
            <div class={Card { size: CardSize::Md }}>
                <header class={CardHeader {}}>
                    <h2>"Reset Configuration"</h2>
                    <p>
                        "Reset all HTTP configuration settings back to their original default values. This will clear your saved auth cookie."
                    </p>
                </header>
                <div class={CardContent {}}>
                    <div>
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
            </div>
            <dialog
                class={Dialog { size: DialogSize::Sm }}
                id={ResetDialogId}
                closedby="any"
                aria-labelledby="reset-dialog-title"
            >
                <h2 id="reset-dialog-title">"Reset to defaults?"</h2>
                <Notice variant={AlertVariant::Warning}>
                    <p>
                        "This clears the auth cookie and every rate limit. It cannot be undone."
                    </p>
                </Notice>
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
            <FormNotice errors={errors} />
            <div class={Card { size: CardSize::Md }}>
                <header class={CardHeader {}}><h2>"Authentication"</h2></header>
                <div class={CardContent {}}>
                    <Field
                        id={e.id(f.tcg_auth_cookie)}
                        label="TCGPlayer Auth Cookie"
                        hint="Your TCGAuthTicket_Production cookie value (without the key name)"
                        error={e.message(f.tcg_auth_cookie)}
                    >
                        <span class={InputGroup {}}>
                            <input
                                class={Input {}}
                                ref={cookie}
                                type="password"
                                value={&input.tcg_auth_cookie}
                                autocomplete="off"
                                {..e.control(f.tcg_auth_cookie).hint()}
                            >
                            <button
                                class={(Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }, Reveal)}
                                type="button"
                                aria-pressed="false"
                                on:click={js::reveal(target, cookie)}
                            >
                                "Show"
                            </button>
                        </span>
                    </Field>
                    <Notice variant={AlertVariant::Info}>
                        <strong>"To get your auth cookie:"</strong>
                        <ol>
                            <li>"Log in to TCGPlayer.com"</li>
                            <li>"Open browser DevTools (F12)"</li>
                            <li>"Go to Application/Storage → Cookies"</li>
                            <li>"Copy the value of TCGAuthTicket_Production"</li>
                        </ol>
                    </Notice>
                </div>
            </div>
            <div class={Card { size: CardSize::Md }}>
                <header class={CardHeader {}}><h2>"Request Settings"</h2></header>
                <div class={CardContent {}}>
                    <Field
                        id={e.id(f.user_agent)}
                        label="User Agent"
                        hint="Browser user agent string"
                        error={e.message(f.user_agent)}
                    >
                        <input
                            class={Input {}}
                            value={&input.user_agent}
                            {..e.control(f.user_agent).hint()}
                        >
                    </Field>
                </div>
            </div>
            <div class={Card { size: CardSize::Md }}>
                <header class={CardHeader {}}>
                    <h2>"Adaptive Algorithm Settings"</h2>
                    <p>
                        "Configure the AIMD (Additive Increase, Multiplicative Decrease) algorithm used for adaptive rate limiting. These settings apply globally to all domains with adaptive mode enabled."
                    </p>
                </header>
                <div class={CardContent {}}>
                    <Field
                        id={e.id(f.increase_multiplier)}
                        label="Increase Multiplier"
                        hint="Multiply delay by this factor on rate limit (e.g., 2.0 = double)"
                        error={e.message(f.increase_multiplier)}
                    >
                        <input
                            class={Input {}}
                            type="number"
                            min="1.1"
                            max="5"
                            step="0.1"
                            value={&input.increase_multiplier}
                            {..e.control(f.increase_multiplier).hint()}
                        >
                    </Field>
                    <Field
                        id={e.id(f.floor_step_ms)}
                        label="Floor Step (ms)"
                        hint="Amount to raise the learned floor on each rate limit"
                        error={e.message(f.floor_step_ms)}
                    >
                        <input
                            class={Input {}}
                            type="number"
                            min="10"
                            step="10"
                            value={&input.floor_step_ms}
                            {..e.control(f.floor_step_ms).hint()}
                        >
                    </Field>
                    <Field
                        id={e.id(f.decrease_amount_ms)}
                        label="Decrease Amount (ms)"
                        hint="Amount to decrease delay after a success streak"
                        error={e.message(f.decrease_amount_ms)}
                    >
                        <input
                            class={Input {}}
                            type="number"
                            min="10"
                            step="10"
                            value={&input.decrease_amount_ms}
                            {..e.control(f.decrease_amount_ms).hint()}
                        >
                    </Field>
                    <Field
                        id={e.id(f.success_threshold)}
                        label="Success Threshold"
                        hint="Number of consecutive successes before decreasing delay"
                        error={e.message(f.success_threshold)}
                    >
                        <input
                            class={Input {}}
                            type="number"
                            min="1"
                            step="1"
                            value={&input.success_threshold}
                            {..e.control(f.success_threshold).hint()}
                        >
                    </Field>
                </div>
            </div>
            <div class={Card { size: CardSize::Md }}>
                <header class={CardHeader {}}>
                    <h2>"Domain Rate Limits"</h2>
                    <p>
                        "Configure rate limiting settings for each TCGPlayer API domain. Each domain has its own isolated rate limiter, so hitting a rate limit on one domain won't affect requests to other domains."
                    </p>
                </header>
                <div class={CardContent {}}>
                    // One block, so the content's gap does not open between the domains.
                    <div>
                        for (domain, row) in &input.domains {
                            let r = f.domains.at(domain);
                            let invalid = [r.request_delay_ms, r.rate_limit_cooldown_ms, r.max_concurrent_requests, r.min_request_delay_ms, r.max_request_delay_ms, r.learned_min_delay_ms].into_iter().any(|n| errors.has(n));
                            <details class={(Accordion {}, DomainBox)} open={invalid}>
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
                                        id={e.id(r.request_delay_ms)}
                                        label="Request Delay (ms)"
                                        hint="Delay between consecutive requests (auto-adjusted when adaptive is enabled)"
                                        error={e.message(r.request_delay_ms)}
                                    >
                                        // No step: the adaptive limiter writes this delay (a floor of
                                        // 250 is a delay of 250), and a step would keep the whole form
                                        // from being sent until it was changed. React's form did not
                                        // check (corten#850).
                                        <input
                                            class={Input {}}
                                            type="number"
                                            min="0"
                                            value={&row.request_delay_ms}
                                            {..e.control(r.request_delay_ms).hint()}
                                        >
                                    </Field>
                                    <Field
                                        id={e.id(r.rate_limit_cooldown_ms)}
                                        label="Rate Limit Cooldown (ms)"
                                        hint="Cooldown after 403/429 response"
                                        error={e.message(r.rate_limit_cooldown_ms)}
                                    >
                                        <input
                                            class={Input {}}
                                            type="number"
                                            min="0"
                                            step="1000"
                                            value={&row.rate_limit_cooldown_ms}
                                            {..e.control(r.rate_limit_cooldown_ms).hint()}
                                        >
                                    </Field>
                                    <Field
                                        id={e.id(r.max_concurrent_requests)}
                                        label="Max Concurrent Requests"
                                        hint="Maximum simultaneous requests to this domain"
                                        error={e.message(r.max_concurrent_requests)}
                                    >
                                        <input
                                            class={Input {}}
                                            type="number"
                                            min="1"
                                            max="10"
                                            value={&row.max_concurrent_requests}
                                            {..e.control(r.max_concurrent_requests).hint()}
                                        >
                                    </Field>
                                    <fieldset class={Bounds}>
                                        <legend>"Adaptive Bounds"</legend>
                                        <Field
                                            id={e.id(r.min_request_delay_ms)}
                                            label="Min Request Delay (ms)"
                                            hint="Absolute minimum delay (starting point for probing)"
                                            error={e.message(r.min_request_delay_ms)}
                                        >
                                            <input
                                                class={Input {}}
                                                type="number"
                                                min="0"
                                                step="50"
                                                value={&row.min_request_delay_ms}
                                                {..e.control(r.min_request_delay_ms).hint()}
                                            >
                                        </Field>
                                        <Field
                                            id={e.id(r.max_request_delay_ms)}
                                            label="Max Request Delay (ms)"
                                            hint="Maximum delay cap"
                                            error={e.message(r.max_request_delay_ms)}
                                        >
                                            <input
                                                class={Input {}}
                                                type="number"
                                                min="1000"
                                                step="1000"
                                                value={&row.max_request_delay_ms}
                                                {..e.control(r.max_request_delay_ms).hint()}
                                            >
                                        </Field>
                                        <Field
                                            id={e.id(r.learned_min_delay_ms)}
                                            label="Learned Min Delay (ms)"
                                            hint="Runtime-learned floor (ratchets up on rate limits, reset by setting to Min Request Delay)"
                                            error={e.message(r.learned_min_delay_ms)}
                                        >
                                            // No step, as the request delay: the limiter writes it.
                                            <input
                                                class={Input {}}
                                                type="number"
                                                min="0"
                                                value={&row.learned_min_delay_ms}
                                                {..e.control(r.learned_min_delay_ms).hint()}
                                            >
                                        </Field>
                                    </fieldset>
                                </div>
                            </details>
                        }
                    </div>
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::http_configuration::config::{Domain, HttpConfig};

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
        // Each control is described by its field's hint, which is on the page.
        let described: Vec<&str> = html
            .split("aria-describedby=\"")
            .skip(1)
            .map(|rest| &rest[..rest.find('"').unwrap()])
            .collect();
        assert_eq!(described.len(), labels, "{html}");
        for id in described {
            assert!(id.ends_with("-hint"), "{id}");
            assert_eq!(html.matches(&format!(" id=\"{id}\"")).count(), 1, "{id}");
        }
        assert!(html.contains("role=\"switch\""));
        assert!(html.contains("command=\"show-modal\""));
        assert!(!html.contains("data-primary"));
    }
}
