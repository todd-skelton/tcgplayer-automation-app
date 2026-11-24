use corten::{
    i18n::{Currency, Minor},
    prelude::*,
};
use corten_ui::dialog;

use super::batch_panel::Refused;
use crate::{
    features::{
        batch_pricer::{
            manual_review::{MOST_NOTE, ManualPriceInput, RemovalInput},
            page::Shown,
            url,
        },
        batch_pricing::manual_review::NeedsReview,
    },
    layout::{DialogNotSent, FormNotice, Notice},
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardPanel, CardSize},
        dialog::{Dialog, DialogFooter, DialogSize},
        field::Field,
        input::Input,
    },
};

const USD: Currency = Currency::new("USD");

#[derive(Id)]
struct ManualReviewTitleId;
/// A SKU's price form, by the SKU: a refused price's answer replaces it.
#[derive(Id)]
pub struct ManualPriceFormId(pub i32);
/// The dialog confirming a SKU's removal, by the SKU.
#[derive(Id)]
struct RemoveDialogId(i32);
#[derive(Id)]
struct RemoveHeadingId(i32);

/// The SKUs the batch's pricing left for manual review, each with what pricing said, a form to
/// price it by hand and a way to remove it when it was never in hand; nothing when there are none.
/// Priced by hand, a SKU is ready to publish and no longer counts for review. Both wait while the
/// batch prices, which would replace the price.
#[component(css)]
pub fn ManualReview<'a>(shown: &'a Shown, refused: Option<Refused<'a>>, t: Msg) -> impl Render {
    let batch = shown.batch.batch_number;
    let pricing = shown.batch.pricing();
    let none = Errors::new();
    let refused = match refused {
        Some(Refused::Price { input, errors }) => Some((input, errors)),
        _ => None,
    };
    html! {
        match &shown.review {
            Err(message) => {
                if !message.is_empty() {
                    <Notice variant={AlertVariant::Warning}>
                        "The batch's results needing review could not be read: "{message}
                    </Notice>
                }
            }
            Ok(review) => {
                if review.total > 0 {
                    <section
                        class={(CardPanel { size: CardSize::Sm }, ManualReview)}
                        aria-labelledby={ManualReviewTitleId}
                    >
                        <h2 id={ManualReviewTitleId}>"Manual review"</h2>
                        <p class={muted()}>
                            "Pricing could not price these SKUs. Enter a price for each to list it; it can then be published from the batch's actions. Pricing the whole batch again replaces prices entered here. A SKU added by mistake, never in hand, can be removed from the batch instead."
                        </p>
                        if pricing {
                            <Notice variant={AlertVariant::Info}>
                                "Prices can be entered, or SKUs removed, once the batch's pricing ends."
                            </Notice>
                        }
                        if review.total > review.listed.len() as i64 {
                            <p class={muted()}>
                                "Showing "{review.listed.len()}" of "{review.total}
                                ". Download Manual Review / Errors for the rest."
                            </p>
                        }
                        for item in &review.listed {
                            <ReviewItem
                                batch={batch}
                                item={item}
                                pricing={pricing}
                                refused={refused.filter(|(input, _)| input.sku == item.sku)}
                                none={&none}
                                t={t}
                            />
                        }
                    </section>
                }
            }
        }
    }
}

/// One SKU left for review: what it is, what pricing said and the prices it saw, and its form.
#[component(css = ManualReview)]
fn ReviewItem<'a>(
    batch: i32,
    item: &'a NeedsReview,
    pricing: bool,
    refused: Option<(&'a ManualPriceInput, &'a Errors)>,
    none: &'a Errors,
    t: Msg,
) -> impl Render {
    let blank = ManualPriceInput::of(item.sku);
    let money = |dollars: f64| t.money(Minor((dollars * 100.0).round() as i64), USD);
    let seen = [
        ("Market", item.market_price),
        ("Lowest sale", item.lowest_sale_price),
        ("Highest sale", item.highest_sale_price),
    ];
    let seen: Vec<_> = seen
        .into_iter()
        .filter_map(|(label, price)| Some((label, price?)))
        .collect();
    html! {
        <article class={Item}>
            <header class={row(Space::_2)}>
                <h3>
                    "SKU "{item.sku}
                    if !item.product.is_empty() {
                        ": "{&item.product}
                    }
                </h3>
                <span class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Soft }}>
                    "manual review"
                </span>
                <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Outline }}>
                    {item.quantity}" quantity"
                </span>
            </header>
            <p class={muted()}>
                {&item.product_line}" - "{&item.set_name}" - "{&item.condition}
            </p>
            for error in &item.errors {
                <p class={Said}>{error}</p>
            }
            for warning in &item.warnings {
                <p class={muted()}>{warning}</p>
            }
            <p class={muted()}>
                if seen.is_empty() {
                    "No market price or sales were found."
                } else {
                    for (n, (label, price)) in seen.iter().enumerate() {
                        if n > 0 {
                            "; "
                        }
                        {*label}" "{money(*price)}
                    }
                    "."
                }
            </p>
            if !pricing {
                <PriceForm
                    batch={batch}
                    input={refused.map_or(&blank, |(input, _)| input)}
                    errors={refused.map_or(none, |(_, errors)| errors)}
                />
                <div>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        type="button"
                        command="show-modal"
                        commandfor={RemoveDialogId(item.sku)}
                    >
                        "Remove from batch"
                    </button>
                </div>
                <RemoveDialog batch={batch} item={item} />
            }
        </article>
    }
}

/// Confirms a SKU's removal: it leaves the batch, and what was received of it is marked never
/// received.
#[component(css = ManualReview)]
fn RemoveDialog<'a>(batch: i32, item: &'a NeedsReview) -> impl Render {
    let said = refs();
    let sku = item.sku;
    html! {
        <dialog
            id={RemoveDialogId(sku)}
            aria-labelledby={RemoveHeadingId(sku)}
            class={Dialog { size: DialogSize::Sm }}
            on:corten:error={dialog::failed(event, target, said)}
        >
            <h2 id={RemoveHeadingId(sku)}>"Remove SKU "{sku}" from batch "{batch}"?"</h2>
            <p>
                "Only for a card that was never in hand. The SKU leaves the batch, and what was received of it ("
                {item.quantity}
                " quantity) is marked never received, so it is neither pending nor counted in the batch's cost. This cannot be undone."
            </p>
            <DialogNotSent said={said} />
            <form
                method="post"
                action={url::RemoveSku { batch }}
                data-patch
                class={DialogFooter {}}
            >
                <input type="hidden" name={RemovalInput::FIELDS.sku} value={sku}>
                <button
                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    type="button"
                    command="close"
                    commandfor={RemoveDialogId(sku)}
                >
                    "Cancel"
                </button>
                <button class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}>
                    "Remove from batch"
                </button>
            </form>
        </dialog>
    }
}

/// The SKU's price and where it came from. A refusal draws it again with what was typed and why.
#[component(css = ManualReview)]
pub fn PriceForm<'a>(batch: i32, input: &'a ManualPriceInput, errors: &'a Errors) -> impl Patch {
    let (f, e) = (
        ManualPriceInput::FIELDS,
        errors.within(ManualPriceFormId(input.sku)),
    );
    html! {
        <form
            id={ManualPriceFormId(input.sku)}
            method="post"
            action={url::ManualPrice { batch }}
            data-patch
            class={stack(Space::_2)}
        >
            <FormNotice errors={errors} />
            <input type="hidden" name={f.sku} value={input.sku}>
            <div class={Controls}>
                <Field id={e.id(f.price)} label="Price" hint="In dollars." error={e.message(f.price)}>
                    <input
                        class={Input {}}
                        type="text"
                        inputmode="decimal"
                        required
                        placeholder="12.50"
                        value={&input.price}
                        {..e.control(f.price).hint()}
                    >
                </Field>
                <Field
                    id={e.id(f.note)}
                    label="Where the price came from"
                    hint="Optional."
                    error={e.message(f.note)}
                >
                    <input
                        class={Input {}}
                        type="text"
                        maxlength={MOST_NOTE}
                        placeholder="Comparable listing, eBay sold"
                        value={&input.note}
                        {..e.control(f.note).hint()}
                    >
                </Field>
            </div>
            <div>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Set price"
                </button>
            </div>
        </form>
    }
}
