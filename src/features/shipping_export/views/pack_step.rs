use corten::prelude::*;
use corten_ui::Tooltip;

use super::SaleValueFigures;
use crate::{
    features::{
        pull_sheet::{Item, ItemCard},
        shipping_export::{
            orders::Order,
            pack::{ListedCard, PackView},
            packing::PackedInput,
            postage::{Bought, Status},
            shipments::Planned,
            steps::Step,
            url::{self, ShippingWorkflow},
            value::SaleValue,
        },
    },
    glyphs,
    text::Msg,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        icon::{self, Icon},
        segmented::SegmentedLinks,
        table::{CellLabel, Table, TableLayout, TableNumeric},
        tip::{Tip, TipText},
        visually_hidden::VisuallyHidden,
    },
};

/// The pack screen's keyboard help.
#[derive(Id)]
struct PackKeysTipId;
/// The shown shipment's full address, its order numbers and its tracking code.
#[derive(Id)]
struct AddressTipId;
#[derive(Id)]
struct OrdersTipId;
#[derive(Id)]
struct TrackingTipId;

/// One shipment as the Pack step lists it.
pub struct PackRow<'a> {
    pub planned: &'a Planned,
    pub orders: Vec<&'a Order>,
    pub items: u32,
    pub value: SaleValue,
    pub postage: Option<&'a Bought>,
    pub packed: bool,
}

/// One order of the shipment being packed: its value, and its cards as pictures or as a list.
pub struct PackedOrder<'a> {
    pub order: &'a Order,
    pub value: SaleValue,
    pub pictures: Vec<(Item, Option<SaleValue>)>,
    pub listed: Vec<ListedCard>,
}

/// The shipment being packed, as the card view shows it.
pub struct PackCard<'a> {
    pub index: usize,
    /// Why its cards are listed rather than shown as pictures, when they are.
    pub notice: Option<(AlertVariant, String)>,
    pub orders: Vec<PackedOrder<'a>>,
}

/// The Pack step: one shipment at a time with its cards to check, or every shipment in a list.
pub struct Packing<'a> {
    pub view: PackView,
    pub rows: Vec<PackRow<'a>>,
    pub card: Option<PackCard<'a>>,
}

/// Where the Pack step is: a shipment, in a view.
fn at(reference: &str, view: PackView) -> ShippingWorkflow {
    ShippingWorkflow {
        shipment: Some(reference.to_owned()),
        view: (view == PackView::List).then_some(view),
        ..ShippingWorkflow::at(Step::Pack)
    }
}

fn postage_chip(bought: &Bought) -> (&'static str, BadgeTone) {
    match bought.result.status {
        Status::Purchased => ("PURCHASED", BadgeTone::Success),
        Status::Failed => ("FAILED", BadgeTone::Destructive),
        Status::Skipped => ("SKIPPED", BadgeTone::Warning),
    }
}

#[component(css)]
pub fn PackStep<'a>(packing: &'a Packing<'a>, t: Msg) -> impl Render {
    html! {
        <div class={PackStep}>
            match (&packing.card, packing.view) {
                (Some(card), PackView::Card) => <ShipmentToPack packing={packing} card={card} t={t} />,
                (_, PackView::List) => <PackList packing={packing} t={t} />,
                (None, PackView::Card) => <Alert variant={AlertVariant::Info}>
                    "No shipments to pack. Load orders first."
                </Alert>,
            }
        </div>
    }
}

/// Card and list, as links: the view is part of the address.
#[component(css = PackStep)]
fn ViewChoice<'a>(packing: &'a Packing<'a>) -> impl Render {
    let current = packing
        .card
        .as_ref()
        .and_then(|c| packing.rows.get(c.index))
        .map_or("", |r| r.planned.reference());
    html! {
        <nav aria-label="View" class={SegmentedLinks {}}>
            <a
                href={at(current, PackView::Card)}
                aria-current={(packing.view == PackView::Card).then_some("page")}
            >
                <Icon glyph={icon::LAYOUT_GRID} />
                "Cards"
            </a>
            <a
                href={at(current, PackView::List)}
                aria-current={(packing.view == PackView::List).then_some("page")}
            >
                <Icon glyph={icon::LIST} />
                "List"
            </a>
        </nav>
    }
}

/// Marks a shipment packed, or not: the form says which, so sending it twice does the same.
/// `form` is the form, for the card view's Space.
#[component(css = PackStep)]
fn PackedToggle<'a>(
    form: Ref<el::HTMLFormElement>,
    reference: &'a str,
    packed: bool,
    view: PackView,
    label: &'a str,
) -> impl Render {
    let f = PackedInput::FIELDS;
    html! {
        <form
            ref={form}
            method="post"
            action={url::ShipmentPacked { reference: reference.to_owned() }}
            class={Toggle}
            data-patch
        >
            <input type="hidden" name={f.packed} value={if packed { "false" } else { "true" }}>
            <input type="hidden" name={f.view} value={view}>
            <button
                aria-pressed={if packed { "true" } else { "false" }}
                class={packed.then_some(Packed)}
            >
                <Icon glyph={if packed { glyphs::SQUARE_CHECK } else { glyphs::SQUARE }} />
                {label}
            </button>
        </form>
    }
}

/// The shipment being packed: who it goes to, its postage, the way to the shipments either side,
/// and each order's cards. Space marks it packed (or not), the arrows move.
#[component(css = PackStep, js)]
pub fn ShipmentToPack<'a>(packing: &'a Packing<'a>, card: &'a PackCard<'a>, t: Msg) -> impl Render {
    let (previous, next, toggle) = refs();
    let keys = js::PackKeys {
        previous,
        next,
        toggle,
    };
    let rows = &packing.rows;
    let current = &rows[card.index];
    let reference = current.planned.reference();
    let first = current
        .orders
        .iter()
        .find(|o| o.number == reference)
        .or(current.orders.first());
    let before = card.index.checked_sub(1).and_then(|i| rows.get(i));
    let after = rows.get(card.index + 1);
    let numbers = &current.planned.orders;
    html! {
        <section class={Shipment} on:document:keydown={js::keys(event, target, keys)}>
            <header class={Head}>
                <span class={Stepper}>
                    <a
                        ref={previous}
                        href={before.map(|r| at(r.planned.reference(), PackView::Card))}
                        aria-disabled={before.is_none().then_some("true")}
                        aria-label="Previous shipment"
                    >
                        <Icon glyph={icon::CHEVRON_LEFT} />
                    </a>
                    <strong>"Shipment "{card.index + 1}" of "{rows.len()}</strong>
                    <a
                        ref={next}
                        href={after.map(|r| at(r.planned.reference(), PackView::Card))}
                        aria-disabled={after.is_none().then_some("true")}
                        aria-label="Next shipment"
                    >
                        <Icon glyph={icon::CHEVRON_RIGHT} />
                    </a>
                </span>
                if let Some(order) = first {
                    <button
                        type="button"
                        class={(TipText {}, Who)}
                        interestfor={AddressTipId}
                        aria-describedby={AddressTipId}
                    >
                        {order.recipient()}
                    </button>
                    <Tooltip id={AddressTipId} class={(Tip {}, Lines)}>{address(order)}</Tooltip>
                    <span class={muted()}>
                        {&order.city}", "{&order.state}" · "{&order.shipping_method}" · "
                        {current.items}
                        if current.items == 1 { " item" } else { " items" }
                    </span>
                }
                if numbers.len() > 1 {
                    <span
                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                    >
                        <button
                            type="button"
                            class={TipText {}}
                            interestfor={OrdersTipId}
                            aria-describedby={OrdersTipId}
                        >
                            "Combined shipment of "{numbers.len()}" orders"
                        </button>
                        <Tooltip id={OrdersTipId} class={Tip {}}>{numbers.join(", ")}</Tooltip>
                    </span>
                }
                if let Some(bought) = current.postage {
                    <span
                        class={Badge { tone: postage_chip(bought).1, emphasis: BadgeEmphasis::Soft }}
                    >
                        if let Some(code) = &bought.result.tracking_code {
                            <button
                                type="button"
                                class={TipText {}}
                                interestfor={TrackingTipId}
                                aria-describedby={TrackingTipId}
                            >
                                {postage_chip(bought).0}
                            </button>
                            <Tooltip id={TrackingTipId} class={Tip {}}>"Tracking "{code}</Tooltip>
                        } else {
                            {postage_chip(bought).0}
                        }
                    </span>
                }
                <span class={Spacer}></span>
                <PackedToggle
                    form={toggle}
                    reference={reference}
                    packed={current.packed}
                    view={PackView::Card}
                    label={if current.packed { "Packed" } else { "Mark Packed" }}
                />
                <button
                    type="button"
                    class={(Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }, Hint)}
                    interestfor={PackKeysTipId}
                    aria-describedby={PackKeysTipId}
                >
                    <Icon glyph={icon::KEYBOARD} />
                    <span class={VisuallyHidden {}}>"Keyboard shortcuts"</span>
                </button>
                <Tooltip id={PackKeysTipId} class={Tip {}}>
                    "Space marks the shipment packed and moves to the next one, or unmarks a packed one. Left and right arrows move between shipments."
                </Tooltip>
                <ViewChoice packing={packing} />
            </header>
            if let Some((tone, notice)) = &card.notice {
                <Alert variant={*tone}>{notice}</Alert>
            }
            for packed in &card.orders {
                <section class={OrderBox} aria-label={format!("Order {}", packed.order.number)}>
                    <header class={row(Space::_3)}>
                        <strong>"Order "{&packed.order.number}</strong>
                        <SaleValueFigures value={&packed.value} on_image={false} t={t} />
                    </header>
                    if !packed.pictures.is_empty() {
                        <div class={Cards}>
                            for (i, (item, value)) in packed.pictures.iter().enumerate() {
                                let drawn = value.as_ref().map(|v| html! { <SaleValueFigures value={v} on_image={true} t={t} /> });
                                <ItemCard
                                    key={i}
                                    search=""
                                    item={item}
                                    detail={drawn.as_ref().map(|d| d as &dyn Render)}
                                />
                            }
                        </div>
                    } else if !packed.listed.is_empty() {
                        <Table layout={TableLayout::Scroll}>
                            <table class={Listed}>
                                <thead>
                                    <tr>
                                        <th>"Card"</th>
                                        <th class={TableNumeric {}}>"Qty"</th>
                                        <th>"Value"</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    for card in &packed.listed {
                                        <tr>
                                            <td>{&card.name}</td>
                                            <td class={TableNumeric {}}>{card.quantity}</td>
                                            <td>
                                                match &card.value {
                                                    Some(value) => <SaleValueFigures
                                                        value={value}
                                                        on_image={false}
                                                        t={t}
                                                    />,
                                                    None => "-",
                                                }
                                            </td>
                                        </tr>
                                    }
                                </tbody>
                            </table>
                        </Table>
                    }
                </section>
            }
        </section>
    }
}

/// Every shipment, each packed or not, the one being packed marked; a row opens it in the card
/// view.
#[component(css = PackStep)]
fn PackList<'a>(packing: &'a Packing<'a>, t: Msg) -> impl Render {
    let current = packing.card.as_ref().map(|c| c.index);
    let forms = refs();
    html! {
        <section class={Shipment}>
            <header class={Head}>
                <strong>"All Shipments"</strong>
                <span class={Spacer}></span>
                <ViewChoice packing={packing} />
            </header>
            <div class={Scroll}>
                <Table layout={TableLayout::Stack}>
                    <table class={Listed}>
                        <thead>
                            <tr>
                                <th scope="col">"Packed"</th>
                                <th scope="col">"Order(s)"</th>
                                <th scope="col">"Recipient"</th>
                                <th scope="col">"Method"</th>
                                <th scope="col" class={TableNumeric {}}>"Items"</th>
                                <th scope="col">"Value"</th>
                                <th scope="col">"Postage"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (i, row) in packing.rows.iter().enumerate() {
                                <tr aria-current={(current == Some(i)).then_some("true")}>
                                    <td>
                                        <CellLabel>"Packed"</CellLabel>
                                        <PackedToggle
                                            form={forms}
                                            reference={row.planned.reference()}
                                            packed={row.packed}
                                            view={PackView::List}
                                            label={if row.packed { "Packed" } else { "Pack" }}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>"Order(s)"</CellLabel>
                                        <a href={at(row.planned.reference(), PackView::Card)}>
                                            for number in &row.planned.orders {
                                                <div>{number}</div>
                                            }
                                        </a>
                                    </td>
                                    <td>
                                        <CellLabel>"Recipient"</CellLabel>
                                        {row.orders.first().map(|o| o.recipient()).unwrap_or_else(|| "-".into())}
                                    </td>
                                    <td>
                                        <CellLabel>"Method"</CellLabel>
                                        {row.orders.first().map_or("-", |o| o.shipping_method.as_str())}
                                    </td>
                                    <td class={TableNumeric {}}>
                                        <CellLabel>"Items"</CellLabel>
                                        {row.items}
                                    </td>
                                    <td class={Wide}>
                                        <CellLabel>"Value"</CellLabel>
                                        <SaleValueFigures
                                            value={&row.value}
                                            on_image={false}
                                            t={t}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>"Postage"</CellLabel>
                                        match row.postage {
                                            Some(bought) => <span
                                                class={Badge { tone: postage_chip(bought).1, emphasis: BadgeEmphasis::Soft }}
                                            >
                                                {postage_chip(bought).0}
                                            </span>,
                                            None => "-",
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            </div>
        </section>
    }
}

/// The order's address, a line each part, for the name's tooltip.
fn address(order: &Order) -> String {
    [
        order.recipient(),
        order.address1.clone(),
        order.address2.clone(),
        format!("{}, {} {}", order.city, order.state, order.postal_code),
        order.country.clone(),
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}
