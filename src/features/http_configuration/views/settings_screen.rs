use corten::{prelude::*, view::Id};

use crate::{
    features::http_configuration::{config::Domain, form::SettingsInput, url},
    theme::*,
    ui::{
        accordion::Accordion,
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeVariant},
        button::{Button, ButtonSize, ButtonVariant},
        card::{Card, CardContent, CardHeader},
        dialog::{Dialog, DialogFooter},
        field::Field,
        input::Input,
        switch::Switch,
    },
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct SettingsFormId;

#[derive(Id)]
struct CookieHintId;

#[derive(Id)]
struct CookieId;

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
            <Card>
                <CardHeader>
                    <h2>"Reset Configuration"</h2>
                    <p>
                        "Reset all HTTP configuration settings back to their original default values. This will clear your saved auth cookie."
                    </p>
                </CardHeader>
                <CardContent>
                    <div>
                        <Button variant={ButtonVariant::Outline} size={ButtonSize::Md}>
                            <button type="button" command="show-modal" commandfor={ResetDialogId}>
                                "Reset to Defaults"
                            </button>
                        </Button>
                    </div>
                </CardContent>
            </Card>
            <Dialog>
                <dialog id={ResetDialogId} closedby="any" aria-labelledby="reset-dialog-title">
                    <h2 id="reset-dialog-title">"Reset to defaults?"</h2>
                    <Alert variant={AlertVariant::Warning}>
                        <p>
                            "This clears the auth cookie and every rate limit. It cannot be undone."
                        </p>
                    </Alert>
                    <form method="post" action={url::ResetSettings}>
                        <DialogFooter>
                            <Button variant={ButtonVariant::Ghost} size={ButtonSize::Md}>
                                <button type="button" command="close" commandfor={ResetDialogId}>
                                    "Cancel"
                                </button>
                            </Button>
                            <Button variant={ButtonVariant::Destructive} size={ButtonSize::Md}>
                                <button>"Confirm Reset"</button>
                            </Button>
                        </DialogFooter>
                    </form>
                </dialog>
            </Dialog>
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
            <Card>
                <CardHeader><h2>"Authentication"</h2></CardHeader>
                <CardContent>
                    <Field
                        id={CookieId::NAME}
                        label="TCGPlayer Auth Cookie"
                        note={(
                            html! {
                                <span id={CookieHintId}>
                                    "Your TCGAuthTicket_Production cookie value (without the key name)"
                                </span>
                            },
                            e.message(f.tcg_auth_cookie),
                        )}
                    >
                        <Input>
                            <input
                                id={CookieId}
                                ref={cookie}
                                type="password"
                                name={f.tcg_auth_cookie}
                                value={&input.tcg_auth_cookie}
                                autocomplete="off"
                                {..e.aria(f.tcg_auth_cookie).hint(&CookieHintId)}
                            >
                        </Input>
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
                </CardContent>
            </Card>
            <Card>
                <CardHeader><h2>"Request Settings"</h2></CardHeader>
                <CardContent>
                    <Field
                        id="user-agent"
                        label="User Agent"
                        note={("Browser user agent string", e.message(f.user_agent))}
                    >
                        <Input>
                            <input
                                id="user-agent"
                                name={f.user_agent}
                                value={&input.user_agent}
                                {..e.aria(f.user_agent)}
                            >
                        </Input>
                    </Field>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <h2>"Adaptive Algorithm Settings"</h2>
                    <p>
                        "Configure the AIMD (Additive Increase, Multiplicative Decrease) algorithm used for adaptive rate limiting. These settings apply globally to all domains with adaptive mode enabled."
                    </p>
                </CardHeader>
                <CardContent>
                    <Field
                        id={"increase-multiplier"}
                        label="Increase Multiplier"
                        note={("Multiply delay by this factor on rate limit (e.g., 2.0 = double)", e.message(f.increase_multiplier))}
                    >
                        <Input>
                            <input
                                id={"increase-multiplier"}
                                type="number"
                                min="1.1"
                                max="5"
                                step="0.1"
                                name={f.increase_multiplier}
                                value={&input.increase_multiplier}
                                {..e.aria(f.increase_multiplier)}
                            >
                        </Input>
                    </Field>
                    <Field
                        id={"floor-step-ms"}
                        label="Floor Step (ms)"
                        note={("Amount to raise the learned floor on each rate limit", e.message(f.floor_step_ms))}
                    >
                        <Input>
                            <input
                                id={"floor-step-ms"}
                                type="number"
                                min="10"
                                step="10"
                                name={f.floor_step_ms}
                                value={&input.floor_step_ms}
                                {..e.aria(f.floor_step_ms)}
                            >
                        </Input>
                    </Field>
                    <Field
                        id={"decrease-amount-ms"}
                        label="Decrease Amount (ms)"
                        note={("Amount to decrease delay after a success streak", e.message(f.decrease_amount_ms))}
                    >
                        <Input>
                            <input
                                id={"decrease-amount-ms"}
                                type="number"
                                min="10"
                                step="10"
                                name={f.decrease_amount_ms}
                                value={&input.decrease_amount_ms}
                                {..e.aria(f.decrease_amount_ms)}
                            >
                        </Input>
                    </Field>
                    <Field
                        id={"success-threshold"}
                        label="Success Threshold"
                        note={("Number of consecutive successes before decreasing delay", e.message(f.success_threshold))}
                    >
                        <Input>
                            <input
                                id={"success-threshold"}
                                type="number"
                                min="1"
                                step="1"
                                name={f.success_threshold}
                                value={&input.success_threshold}
                                {..e.aria(f.success_threshold)}
                            >
                        </Input>
                    </Field>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <h2>"Domain Rate Limits"</h2>
                    <p>
                        "Configure rate limiting settings for each TCGPlayer API domain. Each domain has its own isolated rate limiter, so hitting a rate limit on one domain won't affect requests to other domains."
                    </p>
                </CardHeader>
                <CardContent>
                    <Accordion>
                        for (domain, row) in &input.domains {
                            let r = f.domains.at(domain);
                            let invalid = [r.request_delay_ms, r.rate_limit_cooldown_ms, r.max_concurrent_requests, r.min_request_delay_ms, r.max_request_delay_ms, r.learned_min_delay_ms].into_iter().any(|n| errors.has(n));
                            let id = DomainFieldIds::new(*domain);
                            <details class={DomainBox} open={invalid}>
                                <summary>
                                    <span class={Title}>
                                        <strong>{domain.label()}</strong>
                                        <span class={AdaptiveBadge}>
                                            <Badge variant={BadgeVariant::Primary}>
                                                "Adaptive"
                                            </Badge>
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
                                        id={&id.request_delay}
                                        label="Request Delay (ms)"
                                        note={("Delay between consecutive requests (auto-adjusted when adaptive is enabled)", e.message(r.request_delay_ms))}
                                    >
                                        <Input>
                                            <input
                                                id={&id.request_delay}
                                                type="number"
                                                min="0"
                                                step="100"
                                                name={r.request_delay_ms}
                                                value={&row.request_delay_ms}
                                                {..e.aria(r.request_delay_ms)}
                                            >
                                        </Input>
                                    </Field>
                                    <Field
                                        id={&id.rate_limit_cooldown}
                                        label="Rate Limit Cooldown (ms)"
                                        note={("Cooldown after 403/429 response", e.message(r.rate_limit_cooldown_ms))}
                                    >
                                        <Input>
                                            <input
                                                id={&id.rate_limit_cooldown}
                                                type="number"
                                                min="0"
                                                step="1000"
                                                name={r.rate_limit_cooldown_ms}
                                                value={&row.rate_limit_cooldown_ms}
                                                {..e.aria(r.rate_limit_cooldown_ms)}
                                            >
                                        </Input>
                                    </Field>
                                    <Field
                                        id={&id.max_concurrent}
                                        label="Max Concurrent Requests"
                                        note={("Maximum simultaneous requests to this domain", e.message(r.max_concurrent_requests))}
                                    >
                                        <Input>
                                            <input
                                                id={&id.max_concurrent}
                                                type="number"
                                                min="1"
                                                max="10"
                                                name={r.max_concurrent_requests}
                                                value={&row.max_concurrent_requests}
                                                {..e.aria(r.max_concurrent_requests)}
                                            >
                                        </Input>
                                    </Field>
                                    <fieldset class={Bounds}>
                                        <legend>"Adaptive Bounds"</legend>
                                        <Field
                                            id={&id.min_delay}
                                            label="Min Request Delay (ms)"
                                            note={("Absolute minimum delay (starting point for probing)", e.message(r.min_request_delay_ms))}
                                        >
                                            <Input>
                                                <input
                                                    id={&id.min_delay}
                                                    type="number"
                                                    min="0"
                                                    step="50"
                                                    name={r.min_request_delay_ms}
                                                    value={&row.min_request_delay_ms}
                                                    {..e.aria(r.min_request_delay_ms)}
                                                >
                                            </Input>
                                        </Field>
                                        <Field
                                            id={&id.max_delay}
                                            label="Max Request Delay (ms)"
                                            note={("Maximum delay cap", e.message(r.max_request_delay_ms))}
                                        >
                                            <Input>
                                                <input
                                                    id={&id.max_delay}
                                                    type="number"
                                                    min="1000"
                                                    step="1000"
                                                    name={r.max_request_delay_ms}
                                                    value={&row.max_request_delay_ms}
                                                    {..e.aria(r.max_request_delay_ms)}
                                                >
                                            </Input>
                                        </Field>
                                        <Field
                                            id={&id.learned_min_delay}
                                            label="Learned Min Delay (ms)"
                                            note={("Runtime-learned floor (ratchets up on rate limits, reset by setting to Min Request Delay)", e.message(r.learned_min_delay_ms))}
                                        >
                                            <Input>
                                                <input
                                                    id={&id.learned_min_delay}
                                                    type="number"
                                                    min="0"
                                                    step="100"
                                                    name={r.learned_min_delay_ms}
                                                    value={&row.learned_min_delay_ms}
                                                    {..e.aria(r.learned_min_delay_ms)}
                                                >
                                            </Input>
                                        </Field>
                                    </fieldset>
                                </div>
                            </details>
                        }
                    </Accordion>
                </CardContent>
            </Card>
            <div>
                <Button variant={ButtonVariant::Primary} size={ButtonSize::Md}>
                    <button>"Save Configuration"</button>
                </Button>
            </div>
        </form>
    }
}

/// The ids of one domain's controls, which its fields' labels name.
struct DomainFieldIds {
    request_delay: String,
    rate_limit_cooldown: String,
    max_concurrent: String,
    min_delay: String,
    max_delay: String,
    learned_min_delay: String,
}

impl DomainFieldIds {
    fn new(domain: Domain) -> Self {
        let id = |setting: &str| format!("{}-{setting}", domain.key());
        Self {
            request_delay: id("request-delay"),
            rate_limit_cooldown: id("rate-limit-cooldown"),
            max_concurrent: id("max-concurrent"),
            min_delay: id("min-delay"),
            max_delay: id("max-delay"),
            learned_min_delay: id("learned-min-delay"),
        }
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
        let labels = html.matches("<label for=\"").count();
        assert_eq!(labels, 6 + 6 * Domain::ALL.len(), "{html}");
        for (at, _) in html.match_indices("<label for=\"") {
            let id = &html[at + 12..];
            let id = &id[..id.find('"').unwrap()];
            assert_eq!(html.matches(&format!(" id=\"{id}\"")).count(), 1, "{id}");
        }
        assert!(html.contains("role=\"switch\""));
        assert!(html.contains("command=\"show-modal\""));
        assert!(!html.contains("data-primary"));
    }
}
