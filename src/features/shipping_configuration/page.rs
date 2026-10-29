use corten::prelude::*;

use super::{
    config::{self, ShippingConfig},
    form::SettingsInput,
    url,
    views::{Done, ShippingScreen, ShippingSettingsForm},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
};

pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::ShippingSettings>,
) -> HtmlResult {
    let config = config::load(&db).await?;
    screen(
        &req,
        &db,
        &SettingsInput::of(&config),
        &Errors::new(),
        at.done,
    )
    .await
}

async fn screen(
    req: &Req,
    db: &Database,
    input: &SettingsInput,
    errors: &Errors,
    done: Option<Done>,
) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    req.page(html! {
        <Layout req={req} title="Shipping Configuration" chrome={chrome}>
            <ShippingScreen input={input} errors={errors} done={done} />
        </Layout>
    })
}

/// Saves the settings and loads the page again, saying so; a measure that is not a number gets
/// the form back with why.
pub async fn save(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SettingsInput>,
) -> HtmlResult {
    match input.read() {
        Ok(config) => {
            config::save(&db, &config).await?;
            req.redirect(&url::ShippingSettings {
                done: Some(Done::Saved),
            })
        }
        Err(errors) => {
            req.invalid(
                &errors,
                ShippingSettingsForm {
                    input: &input,
                    errors: &errors,
                },
                || screen(&req, &db, &input, &errors, None),
            )
            .await
        }
    }
}

pub async fn reset(req: Req, State(db): State<Database>) -> HtmlResult {
    config::save(&db, &ShippingConfig::default()).await?;
    req.redirect(&url::ShippingSettings {
        done: Some(Done::Reset),
    })
}
