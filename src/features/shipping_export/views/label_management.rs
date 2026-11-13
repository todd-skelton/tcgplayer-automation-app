use chrono::{DateTime, Utc};
use corten::{
    ToJson,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};
use corten_ui::CopyButton;

use super::{
    shipment_editor::{AddressFields, PackageFields},
    shipping_workflow_screen::Refused,
};
use crate::{
    features::{
        shipping_configuration::{EasyPostMode, Service, ShippingConfig},
        shipping_export::{
            editing::ShipmentInput,
            labels::{Choice, Found, LabelsToBuy},
            postage::{Bought, Status},
            shipments::Direction,
            steps::Step,
            url::{self, ShippingWorkflow},
        },
    },
    layout::{FormNotice, Notice},
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        field::Field,
        input::Input,
        status_dot::{StatusDot, StatusTone},
    },
};

/// The form for the order's labels: a refused purchase or a new choice redraws it.
#[derive(Id)]
pub struct LabelFormId;

/// The order number to look up, a query the lookup's link carries.
#[derive(Id)]
struct OrderNumberId;

/// What the page was asked for and how it writes dates.
pub struct Looked<'a> {
    pub number: Option<&'a str>,
    pub seller: &'a str,
    pub problem: Option<&'a str>,
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
            <Refused problem={looked.problem} />
            <p class={muted()}>
                "Seller key: "<strong>{seller}</strong>". Set the seller key on Load Orders."
            </p>
            <form method="get" action={url::OrderLabels { order: None }} class={Lookup}>
                <Field id={OrderNumberId} label="Order Number" hint="" error="">
                    <input
                        class={Input {}}
                        id={OrderNumberId}
                        name="order"
                        value={looked.number.unwrap_or_default()}
                        placeholder="Enter order number"
                        required
                    >
                </Field>
                <button class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Md }}>
                    "Lookup Order"
                </button>
            </form>
            if let Some(found) = found {
                <section class={Section}>
                    <h2>"Order "{&found.order.number}</h2>
                    <div class={row(Space::_2)}>
                        <span
                            class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                        >
                            {found.order.item_count}" items"
                        </span>
                        <span
                            class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                        >
                            {format!("${:.2}", found.order.value_of_products)}
                        </span>
                        <span
                            class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                        >
                            {&found.order.shipping_method}
                        </span>
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

/// A tracking code's element, which its copy button names; an order can show two labels.
#[derive(Id)]
struct TrackingId<'a>(&'a str);

/// A label bought for the order: how the purchase went, in which mode, at what rate, when, its
/// tracking and the label to open.
#[component(css = LabelManagement)]
fn PurchasedLabel<'a>(title: &'a str, bought: &'a Bought, looked: &'a Looked<'a>) -> impl Render {
    let result = &bought.result;
    let (status, tone) = match result.status {
        Status::Purchased => ("PURCHASED", BadgeTone::Success),
        Status::Failed => ("FAILED", BadgeTone::Destructive),
        Status::Skipped => ("SKIPPED", BadgeTone::Warning),
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
                <span class={Badge { tone, emphasis: BadgeEmphasis::Soft }}>
                    <StatusDot tone={StatusTone::Text} />
                    {status}
                </span>
                <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                    if bought.mode == EasyPostMode::Test { "TEST" } else { "PRODUCTION" }
                </span>
                if let Some(rate) = &result.selected_rate {
                    <span
                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                    >
                        {&rate.service}" "{&rate.rate}" "{&rate.currency}
                    </span>
                }
            </div>
            if let Some(at) = at {
                <p class={muted()}>
                    "Purchased "
                    {t.date_time(at, DateStyle::Short, TimeStyle::Medium)}
                </p>
            }
            if let Some(code) = &result.tracking_code {
                <p class={row(Space::_2)}>
                    "Tracking: "<span id={TrackingId(code)}>{code}</span>
                    <CopyButton
                        text={TrackingId(code)}
                        label="Copy"
                        copied="Copied"
                        class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    />
                </p>
            }
            if let Some(href) = href {
                <a
                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                >
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

/// What the labels form's script fills in when the service changes, as Apply draws it without
/// JavaScript: the package each service gives the order, and the name of the field that chooses
/// the service.
#[derive(ToJson)]
pub struct LabelFormFill {
    /// The service select's name.
    pub service: String,
    /// One for each service the select lists.
    pub packages: Vec<ServicePackage>,
}

/// What a service sets the order's package to (`Shipment::with_service` on the order's own
/// shipment): a letter weighed for the order when it is First, the shipment's own package
/// otherwise.
#[derive(ToJson)]
pub struct ServicePackage {
    /// The service, as its option's value.
    pub service: String,
    /// Each field it sets, by name.
    pub fields: Vec<FieldValue>,
}

/// A form field's name and the value it is given.
#[derive(ToJson)]
pub struct FieldValue {
    pub name: String,
    pub value: String,
}

impl FieldValue {
    fn of<T>(name: FieldName<T>, value: impl ToString) -> FieldValue {
        FieldValue {
            name: name.to_string(),
            value: value.to_string(),
        }
    }
}

impl LabelFormFill {
    /// The package each service gives `found`'s order, the fields a redraw sets for it: every
    /// package field but the service, which the select already shows.
    pub fn of(found: &Found, config: &ShippingConfig) -> LabelFormFill {
        let f = ShipmentInput::FIELDS;
        let packages = Service::ALL
            .into_iter()
            .map(|service| {
                let shipment = found
                    .shipment
                    .with_service(service, config, Some(&found.order));
                let p = ShipmentInput::of(&shipment);
                ServicePackage {
                    service: service.to_string(),
                    fields: vec![
                        FieldValue::of(f.length, p.length),
                        FieldValue::of(f.width, p.width),
                        FieldValue::of(f.height, p.height),
                        FieldValue::of(f.weight, p.weight),
                        FieldValue::of(f.label_format, p.label_format),
                        FieldValue::of(f.label_size, p.label_size),
                    ],
                }
            })
            .collect();
        LabelFormFill {
            service: f.service.to_string(),
            packages,
        }
    }
}

/// The labels to buy and the shipment they are bought from: the order's, edited here only.
/// Choosing other labels shows what buying them says, and another service fills in the package
/// it gives the order ([`LabelFormFill`]), in the browser; without JavaScript the Apply button
/// draws the form again for them on the server.
///
/// Each choice of labels that includes one already bought has its note, and the confirmation that
/// it was shown (`again`), in a fieldset of its own, enabled only while it is chosen, so a buy
/// confirms only the labels its note named.
#[component(css = LabelManagement, js)]
pub fn LabelForm<'a>(
    found: &'a Found,
    config: &'a ShippingConfig,
    input: &'a ShipmentInput,
    buy: LabelsToBuy,
    mode: EasyPostMode,
    errors: &'a Errors,
) -> impl Patch {
    let (choices, shown, notes, says) = refs();
    let (f, c) = (ShipmentInput::FIELDS, Choice::FIELDS);
    let e = errors.within(LabelFormId);
    let number = found.order.number.as_str();
    let order = number.to_owned();
    let test = mode == EasyPostMode::Test;
    let fill = LabelFormFill::of(found, config);
    let already: Vec<(LabelsToBuy, Vec<Direction>)> = LabelsToBuy::ALL
        .into_iter()
        .map(|each| (each, found.bought(each.directions())))
        .collect();
    html! {
        <form
            id={LabelFormId}
            method="post"
            action={url::BuyOrderLabels { order: order.clone() }}
            class={Form}
            data-patch
            on:change={js::changed(event, target, js::Shown { choices, shown, notes, says }, &fill)}
        >
            <FormNotice errors={errors} />
            <fieldset class={Choices}>
                <legend>"Labels to Buy"</legend>
                for each in LabelsToBuy::ALL {
                    <label>
                        <input
                            ref={choices}
                            type="radio"
                            name={c.buy}
                            value={each}
                            checked={each == buy}
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
            <AddressFields input={input} e={&e} />
            <h3>"Package"</h3>
            <PackageFields input={input} e={&e} />
            <input type="hidden" name={f.reference} value={number}>
            <input ref={shown} type="hidden" name={c.shown_service} value={input.service}>
            <p class={muted()}>"Return labels use the same package with the addresses swapped."</p>
            <button
                class={(Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }, Apply)}
                formaction={url::OrderLabelsForm { order: order.clone() }}
            >
                "Apply Choice and Service"
            </button>
            if !mode.has_key() {
                <Notice variant={AlertVariant::Warning}>
                    {mode.key_name()}" is not set. Postage purchase is disabled."
                </Notice>
            }
            for (each, bought) in &already {
                if !bought.is_empty() {
                    <fieldset
                        ref={notes}
                        key={*each}
                        class={Repurchase}
                        hidden={*each != buy}
                        disabled={*each != buy}
                    >
                        <Notice variant={AlertVariant::Warning}>{repurchase(bought)}</Notice>
                        <input type="hidden" name={c.again} value="true">
                    </fieldset>
                }
            }
            <button
                class={Button { variant: if test { ButtonVariant::Warning } else { ButtonVariant::Primary }, size: ButtonSize::Md }}
                disabled={!mode.has_key()}
            >
                for (each, bought) in &already {
                    <span ref={says} key={*each} hidden={*each != buy}>
                        if bought.is_empty() { "Buy " } else { "Buy Another " }
                        {each.label()}
                    </span>
                }
            </button>
        </form>
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{
        shipping_configuration::{LabelFormat, LabelSize},
        shipping_export::{
            orders::tests::order,
            postage::Purchase,
            shipments::{Shipment, shipment_for},
        },
    };

    fn found(items: u32) -> Found {
        let mut order = order("1001");
        order.item_count = items;
        Found {
            shipment: shipment_for(&order, &ShippingConfig::default()),
            order,
            outbound: None,
            returned: None,
        }
    }

    /// Every field of the shipment's part of the form, as the browser sends it.
    fn sent(input: &ShipmentInput) -> Vec<(String, String)> {
        let f = ShipmentInput::FIELDS;
        let pair =
            |name: &dyn ToString, value: &dyn ToString| (name.to_string(), value.to_string());
        vec![
            pair(&f.name, &input.name),
            pair(&f.street1, &input.street1),
            pair(&f.street2, &input.street2),
            pair(&f.city, &input.city),
            pair(&f.state, &input.state),
            pair(&f.zip, &input.zip),
            pair(&f.reference, &input.reference),
            pair(&f.service, &input.service),
            pair(&f.length, &input.length),
            pair(&f.width, &input.width),
            pair(&f.height, &input.height),
            pair(&f.weight, &input.weight),
            pair(&f.label_format, &input.label_format),
            pair(&f.label_size, &input.label_size),
        ]
    }

    /// The form as the script leaves it once `service` is chosen: each field the fill names set
    /// to its value, read back as the server reads the post.
    fn filled(input: &ShipmentInput, fill: &LabelFormFill, service: Service) -> ShipmentInput {
        let package = fill
            .packages
            .iter()
            .find(|p| p.service == service.to_string())
            .expect("every service has a package");
        let mut fields = sent(input);
        for FieldValue { name, value } in &package.fields {
            let field = fields
                .iter_mut()
                .find(|(n, _)| n == name)
                .expect("a field of the form");
            field.1 = value.clone();
        }
        let body: String = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields)
            .finish();
        corten::form::from_bytes(body.as_bytes()).expect("the form reads back")
    }

    /// The package the server draws for a new service (`redraw_labels`).
    fn redrawn(input: &ShipmentInput, found: &Found, service: Service) -> ShipmentInput {
        let mut input = input.clone();
        input.service = service;
        let moved: Shipment = input.with_address(&found.shipment);
        ShipmentInput::of(&moved.with_service(
            service,
            &ShippingConfig::default(),
            Some(&found.order),
        ))
    }

    #[test]
    fn a_new_service_fills_the_package_the_server_draws_for_it() {
        let config = ShippingConfig::default();
        // A letter's order and a parcel's, the package edited by hand and the address too.
        for items in [3, 120] {
            let found = found(items);
            let fill = LabelFormFill::of(&found, &config);
            assert_eq!(fill.service, ShipmentInput::FIELDS.service.to_string());
            let mut edited = ShipmentInput::of(&found.shipment);
            edited.street2 = "Apt 4".into();
            edited.length = "99".into();
            edited.weight = "99".into();
            edited.label_format = LabelFormat::Png;
            edited.label_size = LabelSize::SixByFour;
            for service in Service::ALL {
                let mut chosen = edited.clone();
                chosen.service = service;
                assert_eq!(
                    sent(&filled(&chosen, &fill, service)),
                    sent(&redrawn(&edited, &found, service)),
                    "{service} for {items} items"
                );
            }
        }
    }

    #[test]
    fn first_fills_a_letter_and_another_service_the_orders_package() {
        let config = ShippingConfig::default();
        let found = found(120);
        let fill = LabelFormFill::of(&found, &config);
        let stored = ShipmentInput::of(&found.shipment);
        let letter = filled(&stored, &fill, Service::First);
        assert_eq!(
            (
                letter.length.as_str(),
                letter.width.as_str(),
                letter.height.as_str()
            ),
            ("9", "4", "0.25")
        );
        assert_eq!(letter.label_size, config.letter.label_size);
        let mut edited = letter.clone();
        edited.weight = "5".into();
        let parcel = filled(&edited, &fill, Service::Priority);
        assert_eq!(
            sent(&parcel)[8..],
            sent(&stored)[8..],
            "the order's own package"
        );
    }

    fn bought() -> Bought {
        Bought {
            mode: EasyPostMode::Test,
            result: Purchase {
                reference: "1001".into(),
                order_numbers: vec!["1001".into()],
                status: Status::Purchased,
                easypost_shipment_id: Some("shp_1".into()),
                tracking_code: None,
                selected_rate: None,
                label_url: None,
                label_pdf_url: None,
                error: None,
            },
            purchased_at: None,
        }
    }

    #[test]
    fn each_choice_with_a_label_bought_draws_its_note_shown_while_chosen() {
        let mut found = found(3);
        found.outbound = Some(bought());
        let input = ShipmentInput::of(&found.shipment);
        let errors = Errors::new();
        let html = LabelForm {
            found: &found,
            config: &ShippingConfig::default(),
            input: &input,
            buy: LabelsToBuy::ReturnOnly,
            mode: EasyPostMode::Test,
            errors: &errors,
        }
        .to_html();
        let notes = html.matches("<fieldset data-ref=\"notes\"").count();
        assert_eq!(notes, 2, "outbound only and round-trip: {html}");
        assert!(!html.contains(&repurchase(&[Direction::Return])), "{html}");
        assert_eq!(html.matches(" hidden disabled").count(), 2, "{html}");
        assert!(
            html.contains("data-key=\"return-only\">Buy Return Label</span>"),
            "{html}"
        );
        assert!(
            html.contains("hidden>Buy Another Outbound Label</span>"),
            "{html}"
        );
    }

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
