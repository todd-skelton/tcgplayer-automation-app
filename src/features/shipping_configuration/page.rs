use corten::prelude::*;

use super::{
    config::{self, ShippingConfig},
    form::SettingsInput,
    url,
    views::{ShippingScreen, ShippingSettingsForm},
};
use crate::{database::Database, layout::Layout};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let config = config::load(&db).await?;
    screen(&req, &SettingsInput::of(&config), &Errors::new()).await
}

async fn screen(req: &Req, input: &SettingsInput, errors: &Errors) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="Shipping Configuration" head="">
            <ShippingScreen input={input} errors={errors} />
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
            req.redirect_with_notice(&url::ShippingSettings, "Shipping configuration saved.")
        }
        Err(errors) => {
            req.invalid(
                &errors,
                ShippingSettingsForm {
                    input: &input,
                    errors: &errors,
                },
                || screen(&req, &input, &errors),
            )
            .await
        }
    }
}

pub async fn reset(req: Req, State(db): State<Database>) -> HtmlResult {
    config::save(&db, &ShippingConfig::default()).await?;
    req.redirect_with_notice(
        &url::ShippingSettings,
        "Shipping configuration reset to defaults.",
    )
}
