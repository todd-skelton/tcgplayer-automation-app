use corten::prelude::*;
use corten_ui::{MenuButton, Tooltip};

use super::SaleValueFigures;
use crate::{
    features::{
        shipping_configuration::EasyPostMode,
        shipping_export::{
            buying::BuyInput,
            postage::{Bought, Status},
            shipments::{DeliveryConfirmation, Direction, Planned},
            url::{self, ShippingWorkflow},
            value::SaleValue,
        },
    },
    text::Msg,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        dialog::{Dialog, DialogFooter, DialogSize},
        dropdown_menu::{DropdownMenu, MenuTrigger},
        icon::{self, Icon},
        table::{CellLabel, Table, TableLayout, TableNumeric},
        tip::{Tip, TipText},
        visually_hidden::VisuallyHidden,
    },
};

/// The dialog that asks before a second label is bought: `outbound-` or `return-`, then the
/// shipment's reference.
#[derive(Id)]
struct BuyAgainId<'a>(&'a str);
/// A shipment's actions menu, by its reference.
#[derive(Id)]
struct ShipmentMenuId<'a>(&'a str);
/// The name of a shipment's open-label link, by its reference.
#[derive(Id)]
struct OpenLabelTipId<'a>(&'a str);
/// A shipment's full address, by its reference.
#[derive(Id)]
struct RecipientTipId<'a>(&'a str);
/// A purchase's mode, tracking and rate, by its shipment's reference.
#[derive(Id)]
struct PurchaseTipId<'a>(&'a str);

/// One shipment as the Buy Postage step shows it.
pub struct PostageRow<'a> {
    pub planned: &'a Planned,
    pub items: u32,
    pub value: SaleValue,
    /// Its postage: the label bought, or the last purchase that bought none.
    pub outbound: Option<&'a Bought>,
    pub returned: Option<&'a Bought>,
}

/// Each shipment with its orders, recipient, parcel, value and postage, and the ways to buy its
/// postage or a return label, edit it, or save it as EasyPost's CSV. A second label for a
/// shipment is bought only once the operator says so. Buying is the deployment's mode's, and
/// needs its key.
#[component(css)]
pub fn BuyPostageStep<'a>(rows: &'a [PostageRow<'a>], mode: EasyPostMode, t: Msg) -> impl Render {
    let can_buy = mode.has_key();
    html! {
        <div class={BuyPostageStep}>
            if !can_buy {
                <Alert variant={AlertVariant::Warning}>
                    {mode.key_name()}" is not set. Postage purchase is disabled."
                </Alert>
            }
            <Table layout={TableLayout::Stack}>
                <table class={Shipments}>
                    <thead>
                        <tr>
                            <th scope="col">"Orders"</th>
                            <th scope="col">"Recipient"</th>
                            <th scope="col">"Parcel and value"</th>
                            <th scope="col">"Postage"</th>
                            <th scope="col" class={TableNumeric {}}>"Actions"</th>
                        </tr>
                    </thead>
                    <tbody>
                        for row in rows {
                            <ShipmentPostageRow row={row} mode={mode} can_buy={can_buy} t={t} />
                        }
                    </tbody>
                </table>
            </Table>
        </div>
    }
}

/// A weight as the table shows it: `0.87`, not `0.8700000000000001`.
fn ounces(weight: f64) -> String {
    ((weight * 100.0).round() / 100.0).to_string()
}

#[component(css = BuyPostageStep)]
fn ShipmentPostageRow<'a>(
    row: &'a PostageRow<'a>,
    mode: EasyPostMode,
    can_buy: bool,
    t: Msg,
) -> impl Render {
    let s = &row.planned.shipment;
    let reference = s.reference.as_str();
    let a = &s.to_address;
    let again = row.outbound.is_some_and(|b| b.bought_in(mode));
    let return_again = row.returned.is_some_and(|b| b.bought_in(mode));
    let (outbound_key, return_key) = (
        format!("outbound-{reference}"),
        format!("return-{reference}"),
    );
    let test = mode == EasyPostMode::Test;
    let f = BuyInput::FIELDS;
    let buy = url::BuyShipmentPostage {
        reference: reference.to_owned(),
    };
    let csv = |direction| url::ShipmentCsv {
        reference: reference.to_owned(),
        direction,
    };
    html! {
        <tr>
            <td>
                <CellLabel>"Orders"</CellLabel>
                for number in &row.planned.orders { <div>{number}</div> }
            </td>
            <td>
                <CellLabel>"Recipient"</CellLabel>
                <div>
                    <button
                        type="button"
                        class={TipText {}}
                        interestfor={RecipientTipId(reference)}
                        aria-describedby={RecipientTipId(reference)}
                    >
                        {&a.name}
                    </button>
                    <Tooltip id={RecipientTipId(reference)} class={Tip {}}>{s.recipient()}</Tooltip>
                </div>
                <small class={muted()}>{&a.city}", "{&a.state}" "{&a.zip}</small>
            </td>
            <td>
                <CellLabel>"Parcel and value"</CellLabel>
                <div class={Parcel}>
                    <span>
                        {s.parcel.predefined_package.label()}" · "{ounces(s.parcel.weight)}"oz · "
                        {s.service.label()}" · "{s.options.label_size}" · "{row.items}
                        if row.items == 1 { " item" } else { " items" }
                    </span>
                    if s.options.delivery_confirmation == DeliveryConfirmation::Signature {
                        <span
                            class={Badge { tone: BadgeTone::Warning, emphasis: BadgeEmphasis::Soft }}
                        >
                            "Sig. Required"
                        </span>
                    }
                </div>
                <SaleValueFigures value={&row.value} on_image={false} t={t} />
            </td>
            <td>
                <CellLabel>"Postage"</CellLabel>
                <PostageStatus entry={row.outbound} reference={reference} />
            </td>
            <td class={TableNumeric {}}>
                <CellLabel>"Actions"</CellLabel>
                <div class={Actions}>
                    if again {
                        <button
                            class={Button { variant: if test { ButtonVariant::Warning } else { ButtonVariant::Outline }, size: ButtonSize::Md }}
                            type="button"
                            command="show-modal"
                            commandfor={BuyAgainId(&outbound_key)}
                            disabled={!can_buy}
                        >
                            "Buy Again"
                        </button>
                    } else {
                        <form method="post" action={&buy} data-patch>
                            <input type="hidden" name={f.direction} value={Direction::Outbound}>
                            <button
                                class={Button { variant: if test { ButtonVariant::Warning } else { ButtonVariant::Primary }, size: ButtonSize::Md }}
                                disabled={!can_buy}
                            >
                                "Buy Postage"
                            </button>
                        </form>
                    }
                    <DropdownMenu trigger={MenuTrigger::Icon}>
                        <MenuButton
                            id={ShipmentMenuId(reference)}
                            label={html! {
                                <Icon glyph={icon::ELLIPSIS_VERTICAL} />
                                <span class={VisuallyHidden {}}>"More actions for "{reference}</span>
                            }}
                        >
                            if return_again {
                                <button
                                    type="button"
                                    role="menuitem"
                                    command="show-modal"
                                    commandfor={BuyAgainId(&return_key)}
                                    disabled={!can_buy}
                                >
                                    "Buy Another Return Label"
                                </button>
                            } else {
                                <form method="post" action={&buy} data-patch>
                                    <input
                                        type="hidden"
                                        name={f.direction}
                                        value={Direction::Return}
                                    >
                                    <button role="menuitem" disabled={!can_buy}>
                                        "Buy Return Label"
                                    </button>
                                </form>
                            }
                            if let Some(label) = row.returned.and_then(Bought::label) {
                                <a role="menuitem" href={label} target="_blank" rel="noreferrer">
                                    "Open Return Label"
                                </a>
                            }
                            <a role="menuitem" href={ShippingWorkflow::editing(reference)}>
                                "Edit Shipment"
                            </a>
                            <a role="menuitem" href={csv(None)} download>"Download Shipment CSV"</a>
                            <a role="menuitem" href={csv(Some(Direction::Return))} download>
                                "Download Return CSV"
                            </a>
                        </MenuButton>
                    </DropdownMenu>
                </div>
                if again {
                    <BuyAgainDialog
                        key={&outbound_key}
                        reference={reference}
                        direction={Direction::Outbound}
                        mode={mode}
                    />
                }
                if return_again {
                    <BuyAgainDialog
                        key={&return_key}
                        reference={reference}
                        direction={Direction::Return}
                        mode={mode}
                    />
                }
            </td>
        </tr>
    }
}

/// A purchase's status, with its mode, tracking and rate in a tooltip, its label, and why it
/// bought none.
#[component(css = BuyPostageStep)]
fn PostageStatus<'a>(entry: Option<&'a Bought>, reference: &'a str) -> impl Render {
    html! {
        match entry {
            None => <span class={muted()}>"Not purchased"</span>,
            Some(bought) => {
                <div class={Postage}>
                    <span
                        class={Badge { tone: match bought.result.status {
                                Status::Purchased => BadgeTone::Success,
                                Status::Failed => BadgeTone::Destructive,
                                Status::Skipped => BadgeTone::Warning,
                            }, emphasis: BadgeEmphasis::Soft }}
                    >
                        <button
                            type="button"
                            class={TipText {}}
                            interestfor={PurchaseTipId(reference)}
                            aria-describedby={PurchaseTipId(reference)}
                        >
                            {status_word(bought)}
                        </button>
                    </span>
                    <Tooltip id={PurchaseTipId(reference)} class={Tip {}}>
                        {details(bought)}
                    </Tooltip>
                    if let Some(label) = bought.label() {
                        <a
                            href={label}
                            target="_blank"
                            rel="noreferrer"
                            interestfor={OpenLabelTipId(reference)}
                            aria-labelledby={OpenLabelTipId(reference)}
                        >
                            <Icon glyph={icon::EXTERNAL_LINK} />
                        </a>
                        <Tooltip id={OpenLabelTipId(reference)} class={Tip {}}>
                            "Open label"
                        </Tooltip>
                    }
                    if let Some(error) = &bought.result.error {
                        <small class={Error}>{error}</small>
                    }
                </div>
            }
        }
    }
}

fn status_word(bought: &Bought) -> &'static str {
    match bought.result.status {
        Status::Purchased => "PURCHASED",
        Status::Failed => "FAILED",
        Status::Skipped => "SKIPPED",
    }
}

/// `Mode: test · Tracking: 9400.. · Rate: First $4.52 USD`.
fn details(bought: &Bought) -> String {
    let r = &bought.result;
    [
        Some(format!("Mode: {}", bought.mode.name())),
        r.tracking_code
            .as_ref()
            .map(|code| format!("Tracking: {code}")),
        r.selected_rate
            .as_ref()
            .map(|rate| format!("Rate: {} ${} {}", rate.service, rate.rate, rate.currency)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Asks before buying a second label for a shipment: the first is not refunded.
#[component(css = BuyPostageStep)]
fn BuyAgainDialog<'a>(
    key: &'a str,
    reference: &'a str,
    direction: Direction,
    mode: EasyPostMode,
) -> impl Render {
    let f = BuyInput::FIELDS;
    let (what, bought) = match direction {
        Direction::Outbound => ("label", "Postage"),
        Direction::Return => ("return label", "A return label"),
    };
    html! {
        <dialog
            id={BuyAgainId(key)}
            aria-label={format!("Buy another {what}?")}
            class={(Dialog { size: DialogSize::Sm }, Confirm)}
        >
            <h2>"Buy another "{what}"?"</h2>
            <p>
                {bought}" was already bought for shipment "{reference}" in "{mode.name()}
                " mode. Buying again charges for a new label; the first one is not refunded automatically."
            </p>
            <form
                method="post"
                action={url::BuyShipmentPostage { reference: reference.to_owned() }}
                class={DialogFooter {}}
                data-patch
            >
                <input type="hidden" name={f.direction} value={direction}>
                <input type="hidden" name={f.again} value="true">
                <button
                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    type="button"
                    command="close"
                    commandfor={BuyAgainId(key)}
                >
                    "Cancel"
                </button>
                <button class={Button { variant: ButtonVariant::Warning, size: ButtonSize::Md }}>
                    "Buy Again"
                </button>
            </form>
        </dialog>
    }
}
