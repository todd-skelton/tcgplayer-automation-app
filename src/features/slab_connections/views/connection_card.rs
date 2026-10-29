use std::sync::LazyLock;

use chrono::SecondsFormat;
use corten::prelude::*;

use super::Answered;
use crate::{
    features::slab_connections::{
        form::ConnectionInput,
        provider::{Connection, Provider, Status},
        url,
    },
    layout::{Field, Notice},
    theme::*,
};

/// A provider's card, `connection-alt` or `connection-ebayResearch`: the answer to a post to it
/// replaces it.
#[derive(Id)]
pub struct ConnectionId<'a>(pub &'a str);

/// The screen: a card per provider. It shares the card's stylesheet.
#[component(css = ConnectionCard)]
pub fn ConnectionsScreen<'a>(
    connections: &'a [Connection],
    answered: Option<&'a Answered<'a>>,
) -> impl Render {
    html! {
        <section>
            <h1>"Slab data connections"</h1>
            <p class={mb_4()}>
                "Connect the sources used to research graded cards. Checking access only reads data."
            </p>
            for connection in connections {
                <ConnectionCard
                    connection={connection}
                    answered={answered.filter(|a| a.provider == connection.provider)}
                />
            }
        </section>
    }
}

/// A provider's status, its form, and what the last post to it did. Saving, checking and
/// removing are buttons of one form; checking and removing need a saved connection.
#[component(css)]
pub fn ConnectionCard<'a>(
    connection: &'a Connection,
    answered: Option<&'a Answered<'a>>,
) -> impl Patch {
    // A card nobody posted to has no errors to show, but its fields still read them.
    static NO_ERRORS: LazyLock<Errors> = LazyLock::new(Errors::new);
    let provider = connection.provider;
    let id = ConnectionId(connection.provider.as_ref());
    let errors = answered.map_or(&*NO_ERRORS, |a| a.errors);
    let (f, e) = (ConnectionInput::FIELDS, errors.within(id));
    let saved = connection.configured;
    let status = if saved {
        connection.status
    } else {
        Status::NotConfigured
    };
    html! {
        <section id={ConnectionId(connection.provider.as_ref())} class={(panel(), Card)}>
            <h2>{provider.name()}</h2>
            <p>{status.message()}</p>
            match connection.checked_at {
                Some(at) => {
                    <p class={muted()}>
                        "Last check: "{at.to_rfc3339_opts(SecondsFormat::Millis, true)}
                    </p>
                }
                None => {}
            }
            <p class={muted()}>
                match provider {
                    Provider::Alt => "Use the authorization token from your signed-in Alt session.",
                    Provider::EbayResearch => {
                        "Use the Cookie header and User-Agent from your signed-in eBay Research session. Developer API keys do not grant this access."
                    }
                }
                " Saved credentials are never displayed. Replace them after signing in again if access expires."
            </p>
            <form
                method="post"
                action={url::SaveConnection { provider }}
                autocomplete="off"
                data-patch
            >
                <Field
                    label={match provider {
                        Provider::Alt => "Alt authorization token",
                        Provider::EbayResearch => "eBay research Cookie header",
                    }}
                    hint=""
                >
                    <input
                        type="password"
                        name={f.credential}
                        autocomplete="new-password"
                        maxlength="32768"
                        {..e.aria(f.credential)}
                    >
                    {e.message(f.credential)}
                </Field>
                if provider == Provider::EbayResearch {
                    <Field label="Browser User-Agent" hint="">
                        <input
                            name={f.user_agent}
                            value={answered.map_or("", |a| a.user_agent)}
                            maxlength="512"
                            {..e.aria(f.user_agent)}
                        >
                        {e.message(f.user_agent)}
                    </Field>
                }
                <div class={Actions}>
                    <button data-primary>"Save connection"</button>
                    <button formaction={url::CheckConnection { provider }} disabled={!saved}>
                        "Check access"
                    </button>
                    <button formaction={url::RemoveConnection { provider }} disabled={!saved}>
                        "Remove"
                    </button>
                </div>
            </form>
            match answered.and_then(|a| a.outcome) {
                Some(outcome) => <Notice tone={outcome.tone()}>{outcome.message()}</Notice>,
                None => {}
            }
        </section>
    }
}
