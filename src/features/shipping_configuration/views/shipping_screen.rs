use corten::prelude::*;

use crate::{
    features::shipping_configuration::{
        config::{EasyPostMode, LabelFormat, LabelSize, Service},
        form::{Kind, PackageInput, PackageInputGroupFields, SettingsInput},
        url,
    },
    layout::{Field, Notice, Tone},
    theme::*,
};

/// The settings form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct ShippingSettingsFormId;

/// The screen: what the last post did, where the export is, the EasyPost mode and keys, and the
/// settings form. It shares the form's stylesheet.
#[component(css = ShippingSettingsForm)]
pub fn ShippingScreen<'a>(input: &'a SettingsInput, errors: &'a Errors) -> impl Render {
    let mode = EasyPostMode::of_deployment();
    html! {
        <section class={Screen}>
            <h1>"Shipping Configuration"</h1>
            <p class={(muted(), mb_4())}>
                "Manage the saved shipping settings used by the EasyPost shipping export workflow. Save a default seller key for live TCGPlayer order loading, then build or rebuild shipments from the export page."
            </p>
            <Notice tone={Tone::Info}>
                <div class={(row(Space::_3), justify_between())}>
                    <span>
                        "These settings are stored on the server and used by the shipping export tool when it loads live seller orders and generates EasyPost shipment rows."
                    </span>
                    <a
                        href={crate::features::shipping_export::url::ShippingWorkflow { step: None, seller: None, edit: None, shipment: None, view: None, filters: Default::default() }}
                    >
                        "Open Shipping Export"
                    </a>
                </div>
            </Notice>
            if !mode.has_key() {
                <Notice tone={Tone::Warning}>
                    {mode.key_name()}
                    " is not set. Direct postage purchasing will stay disabled until it is configured."
                </Notice>
            }
            <section class={panel()}>
                <div class={(row(Space::_3), justify_between(), mb_4())}>
                    <div>
                        <h2>"Shipping Configuration"</h2>
                        <p class={muted()}>
                            "Sender details, package thresholds, and label defaults used to build EasyPost shipment rows."
                        </p>
                    </div>
                    <form method="post" action={url::ResetShippingSettings}>
                        <button>"Reset Defaults"</button>
                    </form>
                </div>
                <h3>"EasyPost Purchase Mode"</h3>
                <p class={(muted(), mb_3())}>
                    "Direct postage purchases follow the current runtime environment. Development is locked to EasyPost test mode and production is locked to EasyPost production mode."
                </p>
                <div class={(row(Space::_2), mb_4())}>
                    <span class={Chip}>
                        "EasyPost Mode: "
                        match mode {
                            EasyPostMode::Test => "Test",
                            EasyPostMode::Production => "Production",
                        }
                    </span>
                    for key in [EasyPostMode::Test, EasyPostMode::Production] {
                        <span class={(Chip, if key.has_key() { Ready } else { Missing })}>
                            match (key, key.has_key()) {
                                (EasyPostMode::Test, true) => "Test Key Ready",
                                (EasyPostMode::Test, false) => "Missing Test Key",
                                (EasyPostMode::Production, true) => "Production Key Ready",
                                (EasyPostMode::Production, false) => "Missing Production Key",
                            }
                        </span>
                    }
                </div>
                <ShippingSettingsForm input={input} errors={errors} />
            </section>
        </section>
    }
}

/// The settings: the seller key, the sender, each package and the label defaults.
#[component(css)]
pub fn ShippingSettingsForm<'a>(input: &'a SettingsInput, errors: &'a Errors) -> impl Patch {
    let f = SettingsInput::FIELDS;
    html! {
        <form
            id={ShippingSettingsFormId}
            method="post"
            action={url::ShippingSettings}
            class={Settings}
            data-patch
        >
            {errors.form_message()}
            <h3>"Live TCGPlayer Orders"</h3>
            <p class={muted()}>
                "This seller key is used as the default when the shipping export page loads live seller orders directly from TCGPlayer."
            </p>
            <Field
                label="Default Seller Key"
                hint="Leave blank to require entering a seller key on the shipping page."
            >
                <input name={f.default_seller_key} value={&input.default_seller_key}>
            </Field>
            <h3>"From Address"</h3>
            <div class={Columns}>
                <Field label="Sender" hint="">
                    <input name={f.from.name} value={&input.from.name}>
                </Field>
                <Field label="Company" hint="">
                    <input name={f.from.company} value={&input.from.company}>
                </Field>
                <Field label="Phone" hint="">
                    <input type="tel" name={f.from.phone} value={&input.from.phone}>
                </Field>
                <Field label="Email" hint="">
                    <input type="email" name={f.from.email} value={&input.from.email}>
                </Field>
            </div>
            <Field label="Street 1" hint="">
                <input name={f.from.street1} value={&input.from.street1}>
            </Field>
            <Field label="Street 2" hint="">
                <input name={f.from.street2} value={&input.from.street2}>
            </Field>
            <div class={Columns}>
                <Field label="City" hint="">
                    <input name={f.from.city} value={&input.from.city}>
                </Field>
                <Field label="State" hint="">
                    <input name={f.from.state} value={&input.from.state}>
                </Field>
                <Field label="Zip" hint=""><input name={f.from.zip} value={&input.from.zip}></Field>
                <Field label="Country" hint="">
                    <input name={f.from.country} value={&input.from.country}>
                </Field>
            </div>
            for kind in Kind::ALL {
                <h3>{kind.title()}</h3>
                <PackageFields
                    f={kind.fields()}
                    package={input.package(kind)}
                    errors={errors}
                />
            }
            <div class={Columns}>
                <Field label="Label Format" hint="">
                    <select name={f.label_format}>
                        for format in LabelFormat::ALL {
                            <option value={format} selected={format == input.label_format}>
                                {format}
                            </option>
                        }
                    </select>
                </Field>
                <Field label="Expedited Service" hint="">
                    <select name={f.expedited_service}>
                        for service in Service::EXPEDITED {
                            <option value={service} selected={service == input.expedited_service}>
                                {service.label()}
                            </option>
                        }
                    </select>
                </Field>
            </div>
            <label>
                <input type="checkbox" name={f.combine_orders} checked={input.combine_orders}>
                " Combine same-address orders into one shipment"
            </label>
            <div>
                <button data-primary>"Save Settings"</button>
            </div>
        </form>
    }
}

/// One package's inputs, given the package's names in the form (`f={FIELDS.letter}`). A parcel's
/// form has no limits.
#[component(css = ShippingSettingsForm)]
pub fn PackageFields<'a>(
    f: PackageInputGroupFields,
    package: &'a PackageInput,
    errors: &'a Errors,
) -> impl Render {
    let e = errors.within(ShippingSettingsFormId);
    html! {
        <div class={Columns}>
            <Field label="Label Size" hint="">
                <select name={f.label_size}>
                    for size in LabelSize::ALL {
                        <option value={size} selected={size == package.label_size}>{size}</option>
                    }
                </select>
            </Field>
            <Field label="Base Weight (oz)" hint="">
                <input
                    type="number"
                    step="any"
                    min="0"
                    name={f.base_weight_oz}
                    value={&package.base_weight_oz}
                    {..e.aria(f.base_weight_oz)}
                >
                {e.message(f.base_weight_oz)}
            </Field>
            <Field label="Per Item Weight (oz)" hint="">
                <input
                    type="number"
                    step="any"
                    min="0"
                    name={f.per_item_weight_oz}
                    value={&package.per_item_weight_oz}
                    {..e.aria(f.per_item_weight_oz)}
                >
                {e.message(f.per_item_weight_oz)}
            </Field>
            if let (Some(count), Some(value)) = (&package.max_item_count, &package.max_value_usd) {
                <Field label="Max Item Count" hint="">
                    <input
                        type="number"
                        step="any"
                        min="0"
                        name={f.max_item_count}
                        value={count}
                        {..e.aria(f.max_item_count)}
                    >
                    {e.message(f.max_item_count)}
                </Field>
                <Field label="Max Value (USD)" hint="">
                    <input
                        type="number"
                        step="any"
                        min="0"
                        name={f.max_value_usd}
                        value={value}
                        {..e.aria(f.max_value_usd)}
                    >
                    {e.message(f.max_value_usd)}
                </Field>
            }
            <Field label="Length (in)" hint="">
                <input
                    type="number"
                    step="any"
                    min="0"
                    name={f.length_in}
                    value={&package.length_in}
                    {..e.aria(f.length_in)}
                >
                {e.message(f.length_in)}
            </Field>
            <Field label="Width (in)" hint="">
                <input
                    type="number"
                    step="any"
                    min="0"
                    name={f.width_in}
                    value={&package.width_in}
                    {..e.aria(f.width_in)}
                >
                {e.message(f.width_in)}
            </Field>
            <Field label="Height (in)" hint="">
                <input
                    type="number"
                    step="any"
                    min="0"
                    name={f.height_in}
                    value={&package.height_in}
                    {..e.aria(f.height_in)}
                >
                {e.message(f.height_in)}
            </Field>
        </div>
    }
}
