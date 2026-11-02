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
    ui::{
        button::{Button, ButtonSize, ButtonVariant},
        field::Field,
        input::Input,
        select::Select,
        sheet::{Sheet, Side},
    },
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
            class={(Sheet { side: Side::Right }, ShipmentEditor)}
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
            <AddressFields input={input} e={&e} />
            <h3>"Shipment Details"</h3>
            <Field id={e.id(f.reference)} label="Reference" hint="" error={e.message(f.reference)}>
                <input
                    class={Input {}}
                    value={&input.reference}
                    required
                    {..e.control(f.reference)}
                >
            </Field>
            <PackageFields input={input} e={&e} />
            <button
                class={(Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }, Save)}
            >
                "Save Shipment Changes"
            </button>
        </form>
    }
}

/// Where a shipment goes, in the form `e` is of. Nothing in it is checked: the React screens sent
/// it as typed.
#[component(css = ShipmentEditor)]
pub fn AddressFields<'a, I: Id>(input: &'a ShipmentInput, e: &'a Within<'a, I>) -> impl Render {
    let f = ShipmentInput::FIELDS;
    html! {
        <Field id={e.id(f.name)} label="Name" hint="" error="">
            <input class={Input {}} value={&input.name} {..e.control(f.name)}>
        </Field>
        <Field id={e.id(f.street1)} label="Street 1" hint="" error="">
            <input class={Input {}} value={&input.street1} {..e.control(f.street1)}>
        </Field>
        <Field id={e.id(f.street2)} label="Street 2" hint="" error="">
            <input class={Input {}} value={&input.street2} {..e.control(f.street2)}>
        </Field>
        <Field id={e.id(f.city)} label="City" hint="" error="">
            <input class={Input {}} value={&input.city} {..e.control(f.city)}>
        </Field>
        <div class={Pair}>
            <Field id={e.id(f.state)} label="State" hint="" error="">
                <input class={Input {}} value={&input.state} {..e.control(f.state)}>
            </Field>
            <Field id={e.id(f.zip)} label="Zip" hint="" error="">
                <input class={Input {}} value={&input.zip} {..e.control(f.zip)}>
            </Field>
        </div>
    }
}

/// A shipment's service, parcel and label, with why a measure was refused in the form `e` is
/// of.
#[component(css = ShipmentEditor)]
pub fn PackageFields<'a, I: Id>(input: &'a ShipmentInput, e: &'a Within<'a, I>) -> impl Render {
    let f = ShipmentInput::FIELDS;
    html! {
        <Field id={e.id(f.service)} label="Service" hint="" error="">
            <select class={Select {}} data-redraws {..e.control(f.service)}>
                for service in [Service::First, Service::GroundAdvantage, Service::Priority, Service::Express] {
                    <option value={service} selected={service == input.service}>
                        {service.label()}
                    </option>
                }
            </select>
        </Field>
        <div class={Pair}>
            <Measure label="Length (in)" name={f.length} value={&input.length} e={e} />
            <Measure label="Width (in)" name={f.width} value={&input.width} e={e} />
        </div>
        <div class={Pair}>
            <Measure label="Height (in)" name={f.height} value={&input.height} e={e} />
            <Measure label="Weight (oz)" name={f.weight} value={&input.weight} e={e} />
        </div>
        <Field id={e.id(f.label_format)} label="Label Format" hint="" error="">
            <select class={Select {}} {..e.control(f.label_format)}>
                for format in LabelFormat::ALL {
                    <option value={format} selected={format == input.label_format}>
                        {format}
                    </option>
                }
            </select>
        </Field>
        <Field id={e.id(f.label_size)} label="Label Size" hint="" error="">
            <select class={Select {}} {..e.control(f.label_size)}>
                for size in LabelSize::ALL {
                    <option value={size} selected={size == input.label_size}>{size}</option>
                }
            </select>
        </Field>
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
        <Field id={e.id(name)} label={label} hint="" error={e.message(name)}>
            <input
                class={Input {}}
                type="number"
                step="any"
                min="0"
                value={value}
                {..e.control(name)}
            >
        </Field>
    }
}
