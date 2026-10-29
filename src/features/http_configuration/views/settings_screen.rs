use corten::prelude::*;

use super::Done;
use crate::{
    features::http_configuration::{config::Domain, form::SettingsInput, url},
    theme::*,
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct SettingsFormId;

#[derive(Id)]
struct CookieHintId;

#[derive(Id)]
struct CookieId;

/// The screen: what the last post did, the settings form, and the reset. It shares the form's
/// stylesheet.
#[component(css = SettingsForm)]
pub fn SettingsScreen<'a>(
    input: &'a SettingsInput,
    errors: &'a Errors,
    done: Option<Done>,
) -> impl Render {
    html! {
        <section class={Screen}>
            <h1>"HTTP Configuration"</h1>
            <p class={(muted(), mb_4())}>
                "Configure HTTP client settings for TCGPlayer API requests. Changes are saved to the database."
            </p>
            match done {
                Some(Done::Saved) => <p class={(Notice, Ok)} role="status">"Configuration saved"</p>,
                Some(Done::Reset) => <p class={(Notice, Ok)} role="status">"Configuration reset to defaults"</p>,
                None => {}
            }
            <SettingsForm input={input} errors={errors} />
            <section class={panel()}>
                <h2 class={mb_2()}>"Reset Configuration"</h2>
                <p class={(muted(), mb_3())}>
                    "Reset all HTTP configuration settings back to their original default values. This will clear your saved auth cookie."
                </p>
                <details class={Confirm}>
                    <summary>"Reset to Defaults"</summary>
                    <form method="post" action={url::ResetSettings}>
                        <p class={(Notice, Warn)}>
                            "This clears the auth cookie and every rate limit. It cannot be undone."
                        </p>
                        <button class={Danger}>"Confirm Reset"</button>
                    </form>
                </details>
            </section>
        </section>
    }
}

/// The settings. A domain's adaptive bounds show while its switch is on (CSS, no script); they
/// are sent either way, as the React app sent them.
#[component(css, js)]
pub fn SettingsForm<'a>(input: &'a SettingsInput, errors: &'a Errors) -> impl Patch {
    let (f, e) = (SettingsInput::FIELDS, errors.within(SettingsFormId));
    let cookie = refs();
    // The per-domain inputs share a name per column, so their messages are listed here rather
    // than under one input each.
    let repeated = [
        f.request_delay_ms,
        f.rate_limit_cooldown_ms,
        f.max_concurrent_requests,
        f.min_request_delay_ms,
        f.max_request_delay_ms,
        f.learned_min_delay_ms,
    ];
    html! {
        <form
            id={SettingsFormId}
            method="post"
            action={url::HttpSettings { done: None }}
            data-patch
        >
            {errors.form_message()}
            <section class={(panel(), mb_4())}>
                <h2 class={mb_3()}>"Authentication"</h2>
                <div class={Field}>
                    <label for={CookieId}>"TCGPlayer Auth Cookie"</label>
                    <span class={row(Space::_2)}>
                        <input
                            id={CookieId}
                            ref={cookie}
                            type="password"
                            name={f.tcg_auth_cookie}
                            value={&input.tcg_auth_cookie}
                            autocomplete="off"
                            class={grow_1()}
                            {..e.aria(f.tcg_auth_cookie).hint(&CookieHintId)}
                        >
                        <label class={Reveal}>
                            <input type="checkbox" on:change={js::reveal(target, cookie)}>
                            " Show"
                        </label>
                    </span>
                    <small id={CookieHintId} class={muted()}>
                        "Your TCGAuthTicket_Production cookie value (without the key name)"
                    </small>
                    {e.message(f.tcg_auth_cookie)}
                </div>
                <div class={(Notice, Info)}>
                    "To get your auth cookie:"
                    <ol>
                        <li>"Log in to TCGPlayer.com"</li>
                        <li>"Open browser DevTools (F12)"</li>
                        <li>"Go to Application/Storage → Cookies"</li>
                        <li>"Copy the value of TCGAuthTicket_Production"</li>
                    </ol>
                </div>
            </section>
            <section class={(panel(), mb_4())}>
                <h2 class={mb_3()}>"Request Settings"</h2>
                <label class={Field}>
                    <span>"User Agent"</span>
                    <input name={f.user_agent} value={&input.user_agent} {..e.aria(f.user_agent)}>
                    <small class={muted()}>"Browser user agent string"</small>
                    {e.message(f.user_agent)}
                </label>
            </section>
            <section class={(panel(), mb_4())}>
                <h2 class={mb_2()}>"Adaptive Algorithm Settings"</h2>
                <p class={(muted(), mb_3())}>
                    "Configure the AIMD (Additive Increase, Multiplicative Decrease) algorithm used for adaptive rate limiting. These settings apply globally to all domains with adaptive mode enabled."
                </p>
                <div class={Grid}>
                    <label class={Field}>
                        <span>"Increase Multiplier"</span>
                        <input
                            type="number"
                            min="1.1"
                            max="5"
                            step="0.1"
                            name={f.increase_multiplier}
                            value={&input.increase_multiplier}
                            {..e.aria(f.increase_multiplier)}
                        >
                        <small class={muted()}>
                            "Multiply delay by this factor on rate limit (e.g., 2.0 = double)"
                        </small>
                        {e.message(f.increase_multiplier)}
                    </label>
                    <label class={Field}>
                        <span>"Floor Step (ms)"</span>
                        <input
                            type="number"
                            min="10"
                            step="10"
                            name={f.floor_step_ms}
                            value={&input.floor_step_ms}
                            {..e.aria(f.floor_step_ms)}
                        >
                        <small class={muted()}>
                            "Amount to raise the learned floor on each rate limit"
                        </small>
                        {e.message(f.floor_step_ms)}
                    </label>
                    <label class={Field}>
                        <span>"Decrease Amount (ms)"</span>
                        <input
                            type="number"
                            min="10"
                            step="10"
                            name={f.decrease_amount_ms}
                            value={&input.decrease_amount_ms}
                            {..e.aria(f.decrease_amount_ms)}
                        >
                        <small class={muted()}>
                            "Amount to decrease delay after a success streak"
                        </small>
                        {e.message(f.decrease_amount_ms)}
                    </label>
                    <label class={Field}>
                        <span>"Success Threshold"</span>
                        <input
                            type="number"
                            min="1"
                            step="1"
                            name={f.success_threshold}
                            value={&input.success_threshold}
                            {..e.aria(f.success_threshold)}
                        >
                        <small class={muted()}>
                            "Number of consecutive successes before decreasing delay"
                        </small>
                        {e.message(f.success_threshold)}
                    </label>
                </div>
            </section>
            <section class={(panel(), mb_4())}>
                <h2 class={mb_2()}>"Domain Rate Limits"</h2>
                <p class={(muted(), mb_3())}>
                    "Configure rate limiting settings for each TCGPlayer API domain. Each domain has its own isolated rate limiter, so hitting a rate limit on one domain won't affect requests to other domains."
                </p>
                <ul class={Problems}>
                    for (field, message) in errors.iter().filter(|(field, _)| repeated.contains(field)) {
                        <li data-field={field}>{message}</li>
                    }
                </ul>
                for row in input.rows() {
                    <details class={DomainBox}>
                        <summary>
                            <strong>{row.domain.label()}</strong>
                            <span class={AdaptiveChip}>"Adaptive"</span>
                        </summary>
                        <input type="hidden" name={f.domain} value={row.domain}>
                        <div class={Grid}>
                            <label class={Switch}>
                                <input
                                    type="checkbox"
                                    name={f.adaptive}
                                    value={row.domain}
                                    checked={row.adaptive}
                                >
                                " Enable Adaptive Rate Limiting"
                            </label>
                            <label class={Field}>
                                <span>"Request Delay (ms)"</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="100"
                                    name={f.request_delay_ms}
                                    value={row.request_delay_ms}
                                >
                                <small class={muted()}>
                                    "Delay between consecutive requests (auto-adjusted when adaptive is enabled)"
                                </small>
                            </label>
                            <label class={Field}>
                                <span>"Rate Limit Cooldown (ms)"</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="1000"
                                    name={f.rate_limit_cooldown_ms}
                                    value={row.rate_limit_cooldown_ms}
                                >
                                <small class={muted()}>"Cooldown after 403/429 response"</small>
                            </label>
                            <label class={Field}>
                                <span>"Max Concurrent Requests"</span>
                                <input
                                    type="number"
                                    min="1"
                                    max="10"
                                    name={f.max_concurrent_requests}
                                    value={row.max_concurrent_requests}
                                >
                                <small class={muted()}>
                                    "Maximum simultaneous requests to this domain"
                                </small>
                            </label>
                            <fieldset class={Bounds}>
                                <legend>"Adaptive Bounds"</legend>
                                <label class={Field}>
                                    <span>"Min Request Delay (ms)"</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="50"
                                        name={f.min_request_delay_ms}
                                        value={row.min_request_delay_ms}
                                    >
                                    <small class={muted()}>
                                        "Absolute minimum delay (starting point for probing)"
                                    </small>
                                </label>
                                <label class={Field}>
                                    <span>"Max Request Delay (ms)"</span>
                                    <input
                                        type="number"
                                        min="1000"
                                        step="1000"
                                        name={f.max_request_delay_ms}
                                        value={row.max_request_delay_ms}
                                    >
                                    <small class={muted()}>"Maximum delay cap"</small>
                                </label>
                                <label class={Field}>
                                    <span>"Learned Min Delay (ms)"</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="100"
                                        name={f.learned_min_delay_ms}
                                        value={row.learned_min_delay_ms}
                                    >
                                    <small class={muted()}>
                                        "Runtime-learned floor (ratchets up on rate limits, reset by setting to Min Request Delay)"
                                    </small>
                                </label>
                            </fieldset>
                        </div>
                    </details>
                }
                <button data-primary class={SaveButton}>"Save Configuration"</button>
            </section>
        </form>
    }
}

impl corten::view::AttrValue for Domain {
    fn write_attr(&self, name: &str, out: &mut String) {
        self.key().write_attr(name, out)
    }
}
