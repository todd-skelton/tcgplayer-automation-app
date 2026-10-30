use corten::prelude::*;

use super::{
    config::{self, Runtime},
    form::SettingsInput,
    url,
    views::{Done, PublicationForm, PublicationScreen},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
};

pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::PublicationSettings>,
) -> HtmlResult {
    let (settings, runtime) = config::load(&db).await?;
    let input = SettingsInput::of(&settings);
    screen(&req, &db, &input, &runtime, &Errors::new(), at.done).await
}

async fn screen(
    req: &Req,
    db: &Database,
    input: &SettingsInput,
    runtime: &Runtime,
    errors: &Errors,
    done: Option<Done>,
) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    req.page(html! {
        <Layout req={req} title="Inventory Publication" chrome={chrome} head="">
            <PublicationScreen input={input} runtime={runtime} errors={errors} done={done} />
        </Layout>
    })
}

/// Saves the settings and loads the page again, saying so; a number out of its range gets the
/// form back with why.
pub async fn save(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SettingsInput>,
) -> HtmlResult {
    match input.read() {
        Ok(settings) => {
            config::save(&db, &settings).await?;
            req.redirect(&url::PublicationSettings {
                done: Some(Done::Saved),
            })
        }
        Err(errors) => {
            let (_, runtime) = config::load(&db).await?;
            let form = PublicationForm {
                input: &input,
                runtime: &runtime,
                errors: &errors,
            };
            req.invalid(&errors, form, || {
                screen(&req, &db, &input, &runtime, &errors, None)
            })
            .await
        }
    }
}

/// Lets the publisher run again after someone refreshed Seller Portal's sign-in. The settings
/// in the form it was sent from are not saved.
pub async fn resume(req: Req, State(db): State<Database>) -> HtmlResult {
    config::resume(&db).await?;
    req.redirect(&url::PublicationSettings {
        done: Some(Done::Resumed),
    })
}
