use corten::prelude::*;

use crate::{
    features::shipping_configuration::{
        config::{EasyPostMode, LabelFormat, LabelSize, Service},
        form::{Kind, PackageInput, PackageInputGroupFields, SettingsInput},
        url,
    },
    layout::Notice,
    theme::*,
    ui::{
        alert::AlertVariant,
        badge::{Badge, BadgeEmphasis, BadgeTone},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        field::Field,
        input::Input,
        select::Select,
        switch::Switch,
    },
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
            <p class={muted()}>
                "Manage the saved shipping settings used by the EasyPost shipping export workflow. Save a default seller key for live TCGPlayer order loading, then build or rebuild shipments from the export page."
            </p>
            <Notice variant={AlertVariant::Info}>
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
                <Notice variant={AlertVariant::Warning}>
                    {mode.key_name()}
                    " is not set. Direct postage purchasing will stay disabled until it is configured."
                </Notice>
            }
            <section class={(CardPanel {}, CardCompact {})}>
                <div class={(row(Space::_3), justify_between(), mb_4())}>
                    <div>
                        <h2>"Shipping Configuration"</h2>
                        <p class={muted()}>
                            "Sender details, package thresholds, and label defaults used to build EasyPost shipment rows."
                        </p>
                    </div>
                    <form method="post" action={url::ResetShippingSettings}>
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Reset Defaults"
                        </button>
                    </form>
                </div>
                <h3>"EasyPost Purchase Mode"</h3>
                <p class={(muted(), mb_3())}>
                    "Direct postage purchases follow the current runtime environment. Development is locked to EasyPost test mode and production is locked to EasyPost production mode."
                </p>
                <div class={(row(Space::_2), mb_4())}>
                    <span
                        class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}
                    >
                        "EasyPost Mode: "
                        match mode {
                            EasyPostMode::Test => "Test",
                            EasyPostMode::Production => "Production",
                        }
                    </span>
                    for key in [EasyPostMode::Test, EasyPostMode::Production] {
                        <span
                            class={Badge { tone: if key.has_key() { BadgeTone::Success } else { BadgeTone::Warning }, emphasis: BadgeEmphasis::Soft }}
                        >
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
    let (f, e) = (SettingsInput::FIELDS, errors.within(ShippingSettingsFormId));
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
                id={e.id(f.default_seller_key)}
                label="Default Seller Key"
                hint="Leave blank to require entering a seller key on the shipping page."
                error={e.message(f.default_seller_key)}
            >
                <input
                    class={Input {}}
                    value={&input.default_seller_key}
                    {..e.control(f.default_seller_key).hint()}
                >
            </Field>
            <h3>"From Address"</h3>
            <div class={Columns}>
                <Field id={e.id(f.from.name)} label="Sender" hint="" error={e.message(f.from.name)}>
                    <input class={Input {}} value={&input.from.name} {..e.control(f.from.name)}>
                </Field>
                <Field
                    id={e.id(f.from.company)}
                    label="Company"
                    hint=""
                    error={e.message(f.from.company)}
                >
                    <input
                        class={Input {}}
                        value={&input.from.company}
                        {..e.control(f.from.company)}
                    >
                </Field>
                <Field
                    id={e.id(f.from.phone)}
                    label="Phone"
                    hint=""
                    error={e.message(f.from.phone)}
                >
                    <input
                        class={Input {}}
                        type="tel"
                        value={&input.from.phone}
                        {..e.control(f.from.phone)}
                    >
                </Field>
                <Field
                    id={e.id(f.from.email)}
                    label="Email"
                    hint=""
                    error={e.message(f.from.email)}
                >
                    <input
                        class={Input {}}
                        type="email"
                        value={&input.from.email}
                        {..e.control(f.from.email)}
                    >
                </Field>
            </div>
            <Field
                id={e.id(f.from.street1)}
                label="Street 1"
                hint=""
                error={e.message(f.from.street1)}
            >
                <input class={Input {}} value={&input.from.street1} {..e.control(f.from.street1)}>
            </Field>
            <Field
                id={e.id(f.from.street2)}
                label="Street 2"
                hint=""
                error={e.message(f.from.street2)}
            >
                <input class={Input {}} value={&input.from.street2} {..e.control(f.from.street2)}>
            </Field>
            <div class={Columns}>
                <Field id={e.id(f.from.city)} label="City" hint="" error={e.message(f.from.city)}>
                    <input class={Input {}} value={&input.from.city} {..e.control(f.from.city)}>
                </Field>
                <Field
                    id={e.id(f.from.state)}
                    label="State"
                    hint=""
                    error={e.message(f.from.state)}
                >
                    <input class={Input {}} value={&input.from.state} {..e.control(f.from.state)}>
                </Field>
                <Field id={e.id(f.from.zip)} label="Zip" hint="" error={e.message(f.from.zip)}>
                    <input class={Input {}} value={&input.from.zip} {..e.control(f.from.zip)}>
                </Field>
                <Field
                    id={e.id(f.from.country)}
                    label="Country"
                    hint=""
                    error={e.message(f.from.country)}
                >
                    <input
                        class={Input {}}
                        value={&input.from.country}
                        {..e.control(f.from.country)}
                    >
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
                <Field
                    id={e.id(f.label_format)}
                    label="Label Format"
                    hint=""
                    error={e.message(f.label_format)}
                >
                    <select class={Select {}} {..e.control(f.label_format)}>
                        for format in LabelFormat::ALL {
                            <option value={format} selected={format == input.label_format}>
                                {format}
                            </option>
                        }
                    </select>
                </Field>
                <Field
                    id={e.id(f.expedited_service)}
                    label="Expedited Service"
                    hint=""
                    error={e.message(f.expedited_service)}
                >
                    <select class={Select {}} {..e.control(f.expedited_service)}>
                        for service in Service::EXPEDITED {
                            <option
                                value={service}
                                selected={service == input.expedited_service}
                            >
                                {service.label()}
                            </option>
                        }
                    </select>
                </Field>
            </div>
            <Switch label="Combine same-address orders into one shipment">
                <input
                    type="checkbox"
                    role="switch"
                    name={f.combine_orders}
                    checked={input.combine_orders}
                >
            </Switch>
            <div>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Save Settings"
                </button>
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
            <Field
                id={e.id(f.label_size)}
                label="Label Size"
                hint=""
                error={e.message(f.label_size)}
            >
                <select class={Select {}} {..e.control(f.label_size)}>
                    for size in LabelSize::ALL {
                        <option value={size} selected={size == package.label_size}>
                            {size}
                        </option>
                    }
                </select>
            </Field>
            <Field
                id={e.id(f.base_weight_oz)}
                label="Base Weight (oz)"
                hint=""
                error={e.message(f.base_weight_oz)}
            >
                <input
                    class={Input {}}
                    type="number"
                    step="any"
                    min="0"
                    value={&package.base_weight_oz}
                    {..e.control(f.base_weight_oz)}
                >
            </Field>
            <Field
                id={e.id(f.per_item_weight_oz)}
                label="Per Item Weight (oz)"
                hint=""
                error={e.message(f.per_item_weight_oz)}
            >
                <input
                    class={Input {}}
                    type="number"
                    step="any"
                    min="0"
                    value={&package.per_item_weight_oz}
                    {..e.control(f.per_item_weight_oz)}
                >
            </Field>
            if let (Some(count), Some(value)) = (&package.max_item_count, &package.max_value_usd) {
                <Field
                    id={e.id(f.max_item_count)}
                    label="Max Item Count"
                    hint=""
                    error={e.message(f.max_item_count)}
                >
                    <input
                        class={Input {}}
                        type="number"
                        step="any"
                        min="0"
                        value={count}
                        {..e.control(f.max_item_count)}
                    >
                </Field>
                <Field
                    id={e.id(f.max_value_usd)}
                    label="Max Value (USD)"
                    hint=""
                    error={e.message(f.max_value_usd)}
                >
                    <input
                        class={Input {}}
                        type="number"
                        step="any"
                        min="0"
                        value={value}
                        {..e.control(f.max_value_usd)}
                    >
                </Field>
            }
            <Field
                id={e.id(f.length_in)}
                label="Length (in)"
                hint=""
                error={e.message(f.length_in)}
            >
                <input
                    class={Input {}}
                    type="number"
                    step="any"
                    min="0"
                    value={&package.length_in}
                    {..e.control(f.length_in)}
                >
            </Field>
            <Field id={e.id(f.width_in)} label="Width (in)" hint="" error={e.message(f.width_in)}>
                <input
                    class={Input {}}
                    type="number"
                    step="any"
                    min="0"
                    value={&package.width_in}
                    {..e.control(f.width_in)}
                >
            </Field>
            <Field
                id={e.id(f.height_in)}
                label="Height (in)"
                hint=""
                error={e.message(f.height_in)}
            >
                <input
                    class={Input {}}
                    type="number"
                    step="any"
                    min="0"
                    value={&package.height_in}
                    {..e.control(f.height_in)}
                >
            </Field>
        </div>
    }
}
