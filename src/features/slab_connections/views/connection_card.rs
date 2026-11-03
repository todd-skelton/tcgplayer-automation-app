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
    theme::*,
    ui::{
        alert::Alert,
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        field::Field,
        input::Input,
    },
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
        <section
            id={ConnectionId(connection.provider.as_ref())}
            class={(CardPanel {}, CardCompact {}, Connection)}
        >
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
                    id={e.id(f.credential)}
                    label={match provider {
                        Provider::Alt => "Alt authorization token",
                        Provider::EbayResearch => "eBay research Cookie header",
                    }}
                    hint=""
                    error={e.message(f.credential)}
                >
                    <input
                        class={Input {}}
                        type="password"
                        autocomplete="new-password"
                        maxlength="32768"
                        {..e.control(f.credential)}
                    >
                </Field>
                if provider == Provider::EbayResearch {
                    <Field
                        id={e.id(f.user_agent)}
                        label="Browser User-Agent"
                        hint=""
                        error={e.message(f.user_agent)}
                    >
                        <input
                            class={Input {}}
                            value={answered.map_or("", |a| a.user_agent)}
                            maxlength="512"
                            {..e.control(f.user_agent)}
                        >
                    </Field>
                }
                <div class={Actions}>
                    <button
                        class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                    >
                        "Save connection"
                    </button>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        formaction={url::CheckConnection { provider }}
                        disabled={!saved}
                    >
                        "Check access"
                    </button>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        formaction={url::RemoveConnection { provider }}
                        disabled={!saved}
                    >
                        "Remove"
                    </button>
                </div>
            </form>
            match answered.and_then(|a| a.outcome) {
                Some(outcome) => <Alert variant={outcome.tone()}>{outcome.message()}</Alert>,
                None => {}
            }
        </section>
    }
}
