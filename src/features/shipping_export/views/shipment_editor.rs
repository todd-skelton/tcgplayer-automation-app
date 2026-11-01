use corten::form::Within;
use corten::prelude::*;
use corten_ui::dialog;

use crate::{
    features::{
        shipping_configuration::{LabelFormat, LabelSize, Service},
        shipping_export::{
            editing::ShipmentInput,
            steps::Step,
            url::{self, ShippingWorkflow},
        },
    },
    layout::LabeledControl,
    ui::{input::Input, select::Select},
};

/// The editor's form: a refused save replaces it with the fields as sent and why.
#[derive(Id)]
pub struct ShipmentEditorFormId;

/// A shipment's editor, beside the shipments: the address opens it (`?edit=`), and the close
/// link, Escape or a click outside goes back to the step, so a reload shows what was last seen.
#[component(css)]
pub fn ShipmentEditor<'a>(
    reference: &'a str,
    input: &'a ShipmentInput,
    errors: &'a Errors,
) -> impl Render {
    let close = refs();
    html! {
        <dialog
            open
            closedby="any"
            aria-label="Edit Shipment"
            class={ShipmentEditor}
            on:connect={dialog::modalClosedBy(target, close, signal)}
        >
            <header class={Head}>
                <h2>"Edit Shipment"</h2>
                <a ref={close} href={ShippingWorkflow::at(Step::BuyPostage)} aria-label="Close">
                    "✕"
                </a>
            </header>
            <ShipmentEditorForm reference={reference} input={input} errors={errors} />
        </dialog>
    }
}

/// Where the shipment goes, its reference, and its service, parcel and label.
#[component(css = ShipmentEditor)]
pub fn ShipmentEditorForm<'a>(
    reference: &'a str,
    input: &'a ShipmentInput,
    errors: &'a Errors,
) -> impl Patch {
    let f = ShipmentInput::FIELDS;
    let e = errors.within(ShipmentEditorFormId);
    html! {
        <form
            id={ShipmentEditorFormId}
            method="post"
            action={url::EditShipment { reference: reference.to_owned() }}
            class={Form}
            data-patch
        >
            {errors.form_message()}
            <h3>"To Address"</h3>
            <AddressFields input={input} />
            <h3>"Shipment Details"</h3>
            <LabeledControl label="Reference" hint="">
                <Input>
                    <input
                        name={f.reference}
                        value={&input.reference}
                        required
                        {..e.aria(f.reference)}
                    >
                </Input>
                {e.message(f.reference)}
            </LabeledControl>
            <PackageFields input={input} e={&e} />
            <button class={Save}>"Save Shipment Changes"</button>
        </form>
    }
}

/// Where a shipment goes. Nothing in it is checked: the React screens sent it as typed.
#[component(css = ShipmentEditor)]
pub fn AddressFields<'a>(input: &'a ShipmentInput) -> impl Render {
    let f = ShipmentInput::FIELDS;
    html! {
        <LabeledControl label="Name" hint="">
            <Input>
                <input name={f.name} value={&input.name}>
            </Input>
        </LabeledControl>
        <LabeledControl label="Street 1" hint="">
            <Input>
                <input name={f.street1} value={&input.street1}>
            </Input>
        </LabeledControl>
        <LabeledControl label="Street 2" hint="">
            <Input>
                <input name={f.street2} value={&input.street2}>
            </Input>
        </LabeledControl>
        <LabeledControl label="City" hint="">
            <Input>
                <input name={f.city} value={&input.city}>
            </Input>
        </LabeledControl>
        <div class={Pair}>
            <LabeledControl label="State" hint="">
                <Input>
                    <input name={f.state} value={&input.state}>
                </Input>
            </LabeledControl>
            <LabeledControl label="Zip" hint="">
                <Input>
                    <input name={f.zip} value={&input.zip}>
                </Input>
            </LabeledControl>
        </div>
    }
}

/// A shipment's service, parcel and label, with why a measure was refused in the form `e` is
/// of.
#[component(css = ShipmentEditor)]
pub fn PackageFields<'a, I: Id>(input: &'a ShipmentInput, e: &'a Within<'a, I>) -> impl Render {
    let f = ShipmentInput::FIELDS;
    html! {
        <LabeledControl label="Service" hint="">
            <Select>
                <select name={f.service} data-redraws>
                    for service in [Service::First, Service::GroundAdvantage, Service::Priority, Service::Express] {
                        <option value={service} selected={service == input.service}>
                            {service.label()}
                        </option>
                    }
                </select>
            </Select>
        </LabeledControl>
        <div class={Pair}>
            <Measure label="Length (in)" name={f.length} value={&input.length} e={e} />
            <Measure label="Width (in)" name={f.width} value={&input.width} e={e} />
        </div>
        <div class={Pair}>
            <Measure label="Height (in)" name={f.height} value={&input.height} e={e} />
            <Measure label="Weight (oz)" name={f.weight} value={&input.weight} e={e} />
        </div>
        <LabeledControl label="Label Format" hint="">
            <Select>
                <select name={f.label_format}>
                    for format in LabelFormat::ALL {
                        <option value={format} selected={format == input.label_format}>
                            {format}
                        </option>
                    }
                </select>
            </Select>
        </LabeledControl>
        <LabeledControl label="Label Size" hint="">
            <Select>
                <select name={f.label_size}>
                    for size in LabelSize::ALL {
                        <option value={size} selected={size == input.label_size}>{size}</option>
                    }
                </select>
            </Select>
        </LabeledControl>
    }
}

#[component(css = ShipmentEditor)]
fn Measure<'a, I: Id>(
    label: &'a str,
    name: FieldName<String>,
    value: &'a str,
    e: &'a Within<'a, I>,
) -> impl Render {
    html! {
        <LabeledControl label={label} hint="">
            <Input>
                <input type="number" step="any" min="0" name={name} value={value} {..e.aria(name)}>
            </Input>
            {e.message(name)}
        </LabeledControl>
    }
}
