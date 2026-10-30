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
    layout::Field,
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
            <Field label="Name" hint=""><input name={f.name} value={&input.name}></Field>
            <Field label="Street 1" hint=""><input name={f.street1} value={&input.street1}></Field>
            <Field label="Street 2" hint=""><input name={f.street2} value={&input.street2}></Field>
            <Field label="City" hint=""><input name={f.city} value={&input.city}></Field>
            <div class={Pair}>
                <Field label="State" hint=""><input name={f.state} value={&input.state}></Field>
                <Field label="Zip" hint=""><input name={f.zip} value={&input.zip}></Field>
            </div>
            <h3>"Shipment Details"</h3>
            <Field label="Reference" hint="">
                <input name={f.reference} value={&input.reference} required {..e.aria(f.reference)}>
                {e.message(f.reference)}
            </Field>
            <Field label="Service" hint="">
                <select name={f.service}>
                    for service in [Service::First, Service::GroundAdvantage, Service::Priority, Service::Express] {
                        <option value={service} selected={service == input.service}>
                            {service.label()}
                        </option>
                    }
                </select>
            </Field>
            <div class={Pair}>
                <Measure
                    label="Length (in)"
                    name={f.length}
                    value={&input.length}
                    errors={errors}
                />
                <Measure label="Width (in)" name={f.width} value={&input.width} errors={errors} />
            </div>
            <div class={Pair}>
                <Measure
                    label="Height (in)"
                    name={f.height}
                    value={&input.height}
                    errors={errors}
                />
                <Measure
                    label="Weight (oz)"
                    name={f.weight}
                    value={&input.weight}
                    errors={errors}
                />
            </div>
            <Field label="Label Format" hint="">
                <select name={f.label_format}>
                    for format in LabelFormat::ALL {
                        <option value={format} selected={format == input.label_format}>
                            {format}
                        </option>
                    }
                </select>
            </Field>
            <Field label="Label Size" hint="">
                <select name={f.label_size}>
                    for size in LabelSize::ALL {
                        <option value={size} selected={size == input.label_size}>{size}</option>
                    }
                </select>
            </Field>
            <button class={Save}>"Save Shipment Changes"</button>
        </form>
    }
}

#[component(css = ShipmentEditor)]
fn Measure<'a>(label: &'a str, name: FieldName, value: &'a str, errors: &'a Errors) -> impl Render {
    let e = errors.within(ShipmentEditorFormId);
    html! {
        <Field label={label} hint="">
            <input type="number" step="any" min="0" name={name} value={value} {..e.aria(name)}>
            {e.message(name)}
        </Field>
    }
}
