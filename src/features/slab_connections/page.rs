use corten::prelude::*;

use super::{
    access,
    form::ConnectionInput,
    provider::{Connection, Provider, Status},
    request::Transport,
    store::{self, DatabaseGate},
    url,
    views::{Answered, ConnectionCard, ConnectionsScreen, Outcome},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
};

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let connections = store::connections(&db).await?;
    screen(&req, &db, &connections, None).await
}

async fn screen(
    req: &Req,
    db: &Database,
    connections: &[Connection],
    answered: Option<&Answered<'_>>,
) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    req.page(html! {
        <Layout req={req} title="Slab data connections" chrome={chrome}>
            <ConnectionsScreen connections={connections} answered={answered} />
        </Layout>
    })
}

/// Saves the pasted credential, unchecked; one that breaks the provider's rules gets the form
/// back with why. The credential is never sent back: only eBay's User-Agent is.
pub async fn save(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::SaveConnection>,
    Form(input): Form<ConnectionInput>,
) -> HtmlResult {
    match input.read(at.provider) {
        Ok(credential) => {
            store::save(&db, at.provider, &credential).await?;
            answer(&req, &db, at.provider, Outcome::Saved).await
        }
        Err(errors) => {
            let connections = store::connections(&db).await?;
            let answered = Answered {
                provider: at.provider,
                outcome: None,
                errors: &errors,
                user_agent: &input.user_agent,
            };
            let card = ConnectionCard {
                connection: of(&connections, at.provider),
                answered: Some(&answered),
            };
            req.invalid(&errors, card, || {
                screen(&req, &db, &connections, Some(&answered))
            })
            .await
        }
    }
}

/// One read from the provider with the saved credential. It takes as long as the provider does,
/// up to the request's 30 seconds; leaving the page cancels it, and the provider's lease is
/// released either way.
pub async fn check(
    req: Req,
    State(db): State<Database>,
    State(transport): State<Transport>,
    Params(at): Params<url::CheckConnection>,
) -> HtmlResult {
    let gate = DatabaseGate(db.clone());
    let provider = at.provider;
    let checked = req
        .signal()
        .finish(move |signal| async move {
            let cancelled = async move {
                signal.aborted().await;
            };
            access::check(&transport, &gate, provider, cancelled).await
        })
        .await;
    let found = checked.err().unwrap_or(Status::Connected);
    answer(&req, &db, at.provider, Outcome::Checked(found)).await
}

pub async fn remove(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::RemoveConnection>,
) -> HtmlResult {
    store::remove(&db, at.provider).await?;
    answer(&req, &db, at.provider, Outcome::Removed).await
}

/// The provider's card, saying what was done; without scripts, the page with it.
async fn answer(req: &Req, db: &Database, provider: Provider, outcome: Outcome) -> HtmlResult {
    let connections = store::connections(db).await?;
    let errors = Errors::new();
    let answered = Answered {
        provider,
        outcome: Some(outcome),
        errors: &errors,
        user_agent: "",
    };
    let card = ConnectionCard {
        connection: of(&connections, provider),
        answered: Some(&answered),
    };
    req.patch_or(card, || screen(req, db, &connections, Some(&answered)))
        .await
}

fn of(connections: &[Connection], provider: Provider) -> &Connection {
    connections
        .iter()
        .find(|connection| connection.provider == provider)
        .expect("every provider has a connection, saved or not")
}
