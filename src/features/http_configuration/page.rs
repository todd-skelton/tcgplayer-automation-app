use corten::prelude::*;

use super::{
    config::{self, HttpConfig},
    form::SettingsInput,
    url,
    views::{SettingsForm, SettingsScreen},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let config = config::load(&db).await?;
    screen(&req, &db, &SettingsInput::of(&config), &Errors::new()).await
}

async fn screen(req: &Req, db: &Database, input: &SettingsInput, errors: &Errors) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    req.page(html! {
        <Layout req={req} title="HTTP Configuration" chrome={chrome} head="">
            <SettingsScreen input={input} errors={errors} />
        </Layout>
    })
}

/// Saves the settings and loads the page again, saying so; a setting that does not read gets
/// the form back with why.
pub async fn save(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SettingsInput>,
) -> HtmlResult {
    match input.read() {
        Ok(config) => {
            config::save(&db, &config).await?;
            req.redirect_with_notice(&url::HttpSettings, "Configuration saved")
        }
        Err(errors) => {
            req.invalid(
                &errors,
                SettingsForm {
                    input: &input,
                    errors: &errors,
                },
                || screen(&req, &db, &input, &errors),
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
