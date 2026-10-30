use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use super::shipment_editor::{AddressFields, PackageFields};
use crate::{
    features::{
        shipping_configuration::EasyPostMode,
        shipping_export::{
            editing::ShipmentInput,
            labels::{Choice, Found, LabelsToBuy},
            postage::{Bought, Status},
            shipments::Direction,
            steps::Step,
            url::{self, ShippingWorkflow},
        },
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The form for the order's labels: a refused purchase or a new choice redraws it.
#[derive(Id)]
pub struct LabelFormId;

/// What the page was asked for and how it writes dates.
pub struct Looked<'a> {
    pub number: Option<&'a str>,
    pub seller: &'a str,
    pub problem: Option<&'a str>,
    pub visitor: Visitor,
    pub t: Msg,
}

/// An order looked up by its number, the labels bought for it, and (as `children`) the form
/// to buy more.
#[component(css)]
pub fn LabelManagement<'a>(
    looked: &'a Looked<'a>,
    found: Option<&'a Found>,
    children: impl Render,
) -> impl Render {
    let seller = if looked.seller.is_empty() {
        "(not set)"
    } else {
        looked.seller
    };
    html! {
        <div class={LabelManagement}>
            <header class={Head}>
                <h1>"Label Management"</h1>
                <a href={ShippingWorkflow::at(Step::LoadOrders)}>"Back to Shipping Workflow"</a>
            </header>
            if let Some(problem) = looked.problem {
                <Notice tone={Tone::Warning}>{problem}</Notice>
            }
            <p class={muted()}>
                "Seller key: "<strong>{seller}</strong>". Set the seller key on Load Orders."
            </p>
            <form method="get" action={url::OrderLabels { order: None }} class={Lookup}>
                <Field label="Order Number" hint="">
                    <input
                        name="order"
                        value={looked.number.unwrap_or_default()}
                        placeholder="Enter order number"
                        required
                    >
                </Field>
                <button class={(Button, Secondary)}>"Lookup Order"</button>
            </form>
            if let Some(found) = found {
                <section class={Section}>
                    <h2>"Order "{&found.order.number}</h2>
                    <div class={row(Space::_2)}>
                        <span class={Chip}>{found.order.item_count}" items"</span>
                        <span class={Chip}>{format!("${:.2}", found.order.value_of_products)}</span>
                        <span class={Chip}>{&found.order.shipping_method}</span>
                    </div>
                </section>
                <section class={Section}>
                    <h2>"Purchased Labels"</h2>
                    if found.outbound.is_none() && found.returned.is_none() {
                        <p class={muted()}>"No labels have been purchased for this order yet."</p>
                    }
                    if let Some(bought) = &found.outbound {
                        <PurchasedLabel
                            title="Outbound (seller → buyer)"
                            bought={bought}
                            looked={looked}
                        />
                    }
                    if let Some(bought) = &found.returned {
                        <PurchasedLabel
                            title="Return (buyer → seller)"
                            bought={bought}
                            looked={looked}
                        />
                    }
                </section>
                <section class={Section}>{children}</section>
            }
        </div>
    }
}

/// A label bought for the order: how the purchase went, in which mode, at what rate, when, its
/// tracking and the label to open.
#[component(css = LabelManagement)]
fn PurchasedLabel<'a>(title: &'a str, bought: &'a Bought, looked: &'a Looked<'a>) -> impl Render {
    let result = &bought.result;
    let (status, tone) = match result.status {
        Status::Purchased => ("PURCHASED", Good),
        Status::Failed => ("FAILED", Bad),
        Status::Skipped => ("SKIPPED", Warn),
    };
    let at = bought
        .purchased_at
        .as_deref()
        .and_then(|at| at.parse::<DateTime<Utc>>().ok());
    let href = result
        .label_pdf_url
        .as_deref()
        .or(result.label_url.as_deref());
    let t = looked.t;
    html! {
        <article class={Label}>
            <h3>{title}</h3>
            <div class={row(Space::_2)}>
                <span class={(Chip, tone)}>{status}</span>
                <span class={Chip}>
                    if bought.mode == EasyPostMode::Test { "TEST" } else { "PRODUCTION" }
                </span>
                if let Some(rate) = &result.selected_rate {
                    <span class={Chip}>{&rate.service}" "{&rate.rate}" "{&rate.currency}</span>
                }
            </div>
            if let Some(at) = at {
                <p class={muted()}>
                    "Purchased "
                    {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(looked.visitor)}
                </p>
            }
            if let Some(code) = &result.tracking_code {
                <p>"Tracking: "{code}</p>
            }
            if let Some(href) = href {
                <a href={href} target="_blank" rel="noreferrer" class={Button}>
                    if result.label_pdf_url.is_some() { "Open Label PDF" } else { "Open Label" }
                </a>
            }
            if let Some(error) = &result.error {
                <p class={Bad}>{error}</p>
            }
        </article>
    }
}

/// Why buying again costs more: the labels chosen that were already bought.
fn repurchase(bought: &[Direction]) -> String {
    let already = match bought {
        [Direction::Outbound] => {
            "An outbound label was already purchased for this order. Buying again charges for a new label."
        }
        [Direction::Return] => {
            "A return label was already purchased for this order. Buying again charges for a new label."
        }
        _ => {
            "Outbound and return labels were already purchased for this order. Buying again charges for new labels."
        }
    };
    let replaces = if bought.contains(&Direction::Outbound) {
        " The new outbound label becomes the order's label; refund the old one in EasyPost if it will not be used."
    } else {
        ""
    };
    format!("{already}{replaces}")
}

/// The labels to buy and the shipment they are bought from: the order's, edited here only.
/// Choosing other labels or another service draws the form again for it.
#[component(css = LabelManagement, js)]
pub fn LabelForm<'a>(
    number: &'a str,
    input: &'a ShipmentInput,
    buy: LabelsToBuy,
    bought: &'a [Direction],
    mode: EasyPostMode,
    errors: &'a Errors,
) -> impl Patch {
    let redraw = refs();
    let (f, c) = (ShipmentInput::FIELDS, Choice::FIELDS);
    let e = errors.within(LabelFormId);
    let order = number.to_owned();
    let test = mode == EasyPostMode::Test;
    html! {
        <form
            id={LabelFormId}
            method="post"
            action={url::BuyOrderLabels { order: order.clone() }}
            class={Form}
            data-patch
            on:change={js::changed(event, redraw)}
        >
            {errors.form_message()}
            <fieldset class={Choices}>
                <legend>"Labels to Buy"</legend>
                for each in LabelsToBuy::ALL {
                    <label>
                        <input
                            type="radio"
                            name={c.buy}
                            value={each}
                            checked={each == buy}
                            data-redraws
                        >
                        <span>
                            <strong>
                                match each {
                                    LabelsToBuy::OutboundOnly => { "Outbound only" }
                                    LabelsToBuy::RoundTrip => { "Round-trip" }
                                    LabelsToBuy::ReturnOnly => { "Return only" }
                                }
                            </strong>
                            <small class={muted()}>
                                match each {
                                    LabelsToBuy::OutboundOnly => {
                                        "Buy only an outbound label (seller → buyer). Use to replace a label, such as after correcting the address."
                                    }
                                    LabelsToBuy::RoundTrip => {
                                        "Buy outbound (seller → buyer) + return label (buyer → seller). Use when mailing a physical envelope or replacement."
                                    }
                                    LabelsToBuy::ReturnOnly => {
                                        "Buy only a return label (buyer → seller) to send digitally or include in a package."
                                    }
                                }
                            </small>
                        </span>
                    </label>
                }
            </fieldset>
            <div class={Between}>
                <h3>"Buyer Address"</h3>
                <a href={url::OrderLabels { order: Some(order.clone()) }}>"Reset to Order"</a>
            </div>
            <p class={muted()}>
                "Starts from the TCGplayer order. Changes apply only to labels bought here; the order itself is not updated."
            </p>
            <AddressFields input={input} />
            <h3>"Package"</h3>
            <PackageFields input={input} e={&e} />
            <input type="hidden" name={f.reference} value={number}>
            <input type="hidden" name={c.shown_service} value={input.service}>
            <p class={muted()}>"Return labels use the same package with the addresses swapped."</p>
            <button
                ref={redraw}
                formaction={url::OrderLabelsForm { order: order.clone() }}
                class={Button}
            >
                "Apply Choice and Service"
            </button>
            if !mode.has_key() {
                <Notice tone={Tone::Warning}>
                    {mode.key_name()}" is not set. Postage purchase is disabled."
                </Notice>
            }
            if !bought.is_empty() {
                <Notice tone={Tone::Warning}>{repurchase(bought)}</Notice>
                <input type="hidden" name={c.again} value="true">
            }
            <button disabled={!mode.has_key()} class={(Button, Primary, test.then_some(TestMode))}>
                if bought.is_empty() { "Buy " } else { "Buy Another " }
                {buy.label()}
            </button>
        </form>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buying_again_says_what_it_replaces() {
        assert_eq!(
            repurchase(&[Direction::Return]),
            "A return label was already purchased for this order. Buying again charges for a new label."
        );
        assert!(
            repurchase(&[Direction::Outbound, Direction::Return])
                .starts_with("Outbound and return labels were already purchased")
        );
        assert!(repurchase(&[Direction::Outbound]).ends_with("if it will not be used."));
    }
}
