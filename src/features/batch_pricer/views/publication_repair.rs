use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::{
        batch_pricer::{
            page::Shown,
            repair::{ConfirmInput, MOST_NOTE},
            url,
        },
        inventory_publication::confirmation::Ambiguous,
    },
    layout::FormNotice,
    text::Msg,
    theme::*,
    ui::{
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardPanel, CardSize},
        field::Field,
        input::Input,
    },
};

#[derive(Id)]
struct PublicationRepairTitleId;
/// An item's confirmation form, by the item's id: a refused confirmation's answer replaces it.
#[derive(Id)]
pub struct ConfirmLiveFormId(pub i64);

/// An ambiguous item's confirmation refused: the form as it was sent, and why.
#[derive(Clone, Copy)]
pub struct Refused<'a> {
    pub input: &'a ConfirmInput,
    pub errors: &'a Errors,
}

/// The batch's publication items Seller Portal left ambiguous, each with a form to confirm it
/// live when it adds received inventory; nothing when there are none. Part of the batch's panel,
/// so an item a publication followed live leaves ambiguous shows up as it does.
#[component(css)]
pub fn PublicationRepair<'a>(
    shown: &'a Shown,
    refused: Option<Refused<'a>>,
    t: Msg,
) -> impl Render {
    let items = shown
        .publications
        .as_ref()
        .map_or(&[][..], |p| p.ambiguous.as_slice());
    let batch = shown.batch.batch_number;
    let none = Errors::new();
    html! {
        if !items.is_empty() {
            <section
                class={(CardPanel { size: CardSize::Sm }, PublicationRepair)}
                aria-labelledby={PublicationRepairTitleId}
            >
                <h2 id={PublicationRepairTitleId}>"Ambiguous publication items"</h2>
                <p class={muted()}>
                    "Seller Portal did not say whether these went live, so they are never sent again. Check each SKU in Seller Portal; once its quantity shows live, confirm it here and its received lots become the seller's inventory."
                </p>
                for item in items {
                    <AmbiguousItem
                        batch={batch}
                        item={item}
                        refused={refused.filter(|r| r.input.item == item.item_id)}
                        none={&none}
                        t={t}
                    />
                }
            </section>
        }
    }
}

/// One ambiguous item: what it is, when it was sent, and its form when it can be confirmed.
#[component(css = PublicationRepair)]
fn AmbiguousItem<'a>(
    batch: i32,
    item: &'a Ambiguous,
    refused: Option<Refused<'a>>,
    none: &'a Errors,
    t: Msg,
) -> impl Render {
    let blank = ConfirmInput::of(item.publication_id, item.item_id);
    let adds = if item.quantity_delta > 0 {
        format!("+{}", item.quantity_delta)
    } else {
        item.quantity_delta.to_string()
    };
    html! {
        <article class={Item}>
            <header class={row(Space::_2)}>
                <h3>"SKU "{item.sku}": "{&item.product_name}</h3>
                <span class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Soft }}>
                    "ambiguous"
                </span>
                <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Outline }}>
                    {adds}" quantity"
                </span>
                <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                    "Publication "{item.publication_id}
                </span>
            </header>
            <p class={muted()}>
                {&item.set_name}" - "{&item.condition}
                if let Some(seller) = &item.seller_key {
                    " - seller "{seller}
                }
            </p>
            <p class={muted()}>
                "Sent to Seller Portal "
                {t.date_time(item.sent_at, DateStyle::Short, TimeStyle::Short)}
                if let Some(received) = item.latest_intake_at {
                    "; received "{t.date_time(received, DateStyle::Short, TimeStyle::Short)}
                }
                "."
                if let Some(why) = &item.error_message {
                    " "{why}
                }
            </p>
            if item.confirmable() {
                <ConfirmForm
                    batch={batch}
                    input={refused.map_or(&blank, |r| r.input)}
                    earliest={Some(item.earliest())}
                    errors={refused.map_or(none, |r| r.errors)}
                    t={t}
                />
            } else {
                <p class={muted()}>
                    "Only an item that adds received inventory, with receipt lots for its seller, can be confirmed here."
                </p>
            }
        </article>
    }
}

/// The item's confirmation: the quantity seen live, when (in the visitor's zone) and where. A
/// refusal draws it again with what was typed and why.
#[component(css = PublicationRepair)]
pub fn ConfirmForm<'a>(
    batch: i32,
    input: &'a ConfirmInput,
    earliest: Option<DateTime<Utc>>,
    errors: &'a Errors,
    t: Msg,
) -> impl Patch {
    let (f, e) = (
        ConfirmInput::FIELDS,
        errors.within(ConfirmLiveFormId(input.item)),
    );
    html! {
        <form
            id={ConfirmLiveFormId(input.item)}
            method="post"
            action={url::ConfirmLive { batch }}
            data-patch
            class={stack(Space::_2)}
        >
            <FormNotice errors={errors} />
            <input type="hidden" name={f.publication} value={input.publication}>
            <input type="hidden" name={f.item} value={input.item}>
            <div class={Controls}>
                <Field
                    id={e.id(f.quantity)}
                    label="Quantity seen live"
                    hint=""
                    error={e.message(f.quantity)}
                >
                    <input
                        class={Input {}}
                        type="number"
                        inputmode="numeric"
                        min="1"
                        step="1"
                        required
                        value={&input.quantity}
                        {..e.control(f.quantity).hint()}
                    >
                </Field>
                <Field
                    id={e.id(f.live_at)}
                    label="Went live at"
                    hint={html! {
                        "Your time"
                        if let Some(at) = earliest {
                            ", no earlier than "{t.date_time(at, DateStyle::Short, TimeStyle::Short)}
                        }
                        "."
                    }}
                    error={e.message(f.live_at)}
                >
                    <input
                        class={Input {}}
                        type="datetime-local"
                        required
                        value={&input.live_at}
                        {..e.control(f.live_at).hint()}
                    >
                </Field>
                <Field
                    id={e.id(f.note)}
                    label="Where you saw it"
                    hint=""
                    error={e.message(f.note)}
                >
                    <input
                        class={Input {}}
                        type="text"
                        maxlength={MOST_NOTE}
                        required
                        placeholder="Seller Portal, Live listings"
                        value={&input.note}
                        {..e.control(f.note).hint()}
                    >
                </Field>
            </div>
            <div>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Confirm live"
                </button>
            </div>
        </form>
    }
}
