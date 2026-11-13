use corten::prelude::*;
use corten_ui::Toast;

use super::{
    config::{self, HttpConfig},
    form::SettingsInput,
    url,
    views::{SettingsForm, SettingsScreen},
};
use crate::{
    database::Database,
    layout::{AuthCookieWarning, Layout},
};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let config = config::load(&db).await?;
    screen(&req, &SettingsInput::of(&config), &Errors::new()).await
}

async fn screen(req: &Req, input: &SettingsInput, errors: &Errors) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="HTTP Configuration" head="">
            <SettingsScreen input={input} errors={errors} />
        </Layout>
    })
}

/// Saves the settings and loads the page again, saying so; a setting that does not read gets
/// the form back with why. With JavaScript the answer is a patch, since a navigation would keep
/// the app bar's auth cookie warning as the full load drew it, and the patch draws it again.
pub async fn save(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SettingsInput>,
) -> HtmlResult {
    match input.read() {
        Ok(config) => {
            config::save(&db, &config).await?;
            if req.mode != Mode::Action {
                return req.redirect_with_notice(&url::HttpSettings, "Configuration saved");
            }
            req.patch(html! {
                <SettingsForm input={&SettingsInput::of(&config)} errors={&Errors::new()} />
                <AuthCookieWarning missing={config.tcg_auth_cookie.is_empty()} />
                <Toast message={Some("Configuration saved")} failed={false} />
            })
        }
        Err(errors) => {
            req.invalid(
                &errors,
                SettingsForm {
                    input: &input,
                    errors: &errors,
                },
                || screen(&req, &input, &errors),
            )
            .await
        }
    }
}

/// Every setting back to its default; the auth cookie is cleared.
pub async fn reset(req: Req, State(db): State<Database>) -> HtmlResult {
    config::save(&db, &HttpConfig::default()).await?;
    req.redirect_with_notice(&url::HttpSettings, "Configuration reset to defaults")
}
