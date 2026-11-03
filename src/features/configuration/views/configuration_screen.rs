use corten::prelude::*;
use corten_ui::{Choice, ComboBox, Picker};

use super::{ReportPanels, Reports};

use crate::{
    features::{
        configuration::{
            config::{EVIDENCE_WINDOWS, ProductLines, SHIPPING_THRESHOLDS},
            form::{
                AddLineInput, DefaultPercentileInput, Method, PricingInput, SnapsInput, SupplyInput,
            },
            url,
        },
        http_configuration,
    },
    layout::SubmitsOnChange,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        checkbox::Checkbox,
        field::Field,
        input::Input,
        select::Select,
        switch::Switch,
        table::{Table, TableLayout},
    },
};

#[derive(Id)]
pub struct PricingFormId;
#[derive(Id)]
pub struct SnapsFormId;
#[derive(Id)]
pub struct SupplyFormId;
#[derive(Id)]
pub struct ProductLinesId;
#[derive(Id)]
struct ProductLinePickId;
/// A configured product line's row, `product-line-row-{id}`: after its Remove, focus goes to the
/// table rather than the next row's Remove button.
#[derive(Id)]
struct ProductLineRowId(i32);

/// What one section's form shows: the values as typed, what did not read, and whether the last
/// change was saved.
pub struct Section<'a, I> {
    pub input: &'a I,
    pub errors: &'a Errors,
    pub saved: bool,
}

/// The product line section: what is stored, the product lines to choose from, and the last post
/// to it.
pub struct Lines<'a> {
    pub stored: &'a ProductLines,
    /// Every product line, by name.
    pub names: &'a [(i32, String)],
    pub default: &'a DefaultPercentileInput,
    pub add: &'a AddLineInput,
    pub errors: &'a Errors,
    pub said: Option<&'a str>,
    /// The hurdle a line without its own uses, shown as the field's placeholder.
    pub default_hurdle: f64,
    pub percentiles: (f64, f64),
}

/// The screen: one panel per section, each saved on its own. It owns the stylesheet.
#[component(css)]
pub fn ConfigurationScreen<'a>(
    auth_cookie_missing: bool,
    pricing: Section<'a, PricingInput>,
    lines: Lines<'a>,
    snaps: Section<'a, SnapsInput>,
    reports: &'a Reports<'a>,
    supply: Section<'a, SupplyInput>,
) -> impl Render {
    html! {
        <section>
            <h1>"Configuration Settings"</h1>
            <p class={(muted(), mb_4())}>
                "Pricing, supply analysis, and product line settings are saved to the server so background pricing jobs use the same configuration."
            </p>
            if auth_cookie_missing {
                <Alert variant={AlertVariant::Warning}>
                    <strong>"Authentication Required:"</strong>
                    " You haven't configured your TCGPlayer auth cookie yet. "
                    <a href={http_configuration::url::HttpSettings}>
                        "Configure HTTP Settings"
                    </a>
                </Alert>
            }
            <PricingForm section={pricing} />
            <ProductLinesSection lines={lines} />
            <SnapsForm section={snaps} />
            <ReportPanels reports={reports} />
            <SupplyForm section={supply} />
            <section class={(CardPanel {}, CardCompact {}, Section)}>
                <h2>"Reset Configuration"</h2>
                <p class={muted()}>
                    "Reset all configuration settings back to their original default values."
                </p>
                <details>
                    <summary>"Reset to Defaults"</summary>
                    <form method="post" action={url::ResetConfiguration}>
                        <Alert variant={AlertVariant::Warning}>
                            "This resets every setting on this page. It cannot be undone."
                        </Alert>
                        <button
                            class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}
                        >
                            "Confirm Reset to Defaults"
                        </button>
                    </form>
                </details>
            </section>
        </section>
    }
}

fn saved(saved: bool) -> impl Render {
    html! {
        if saved {
            <p role="status">"Configuration updated"</p>
        }
    }
}

#[component(css = ConfigurationScreen)]
pub fn PricingForm<'a>(section: &'a Section<'a, PricingInput>) -> impl Patch {
    let (input, errors) = (section.input, section.errors);
    let f = PricingInput::FIELDS;
    let number =
        move |name: FieldName<String>,
              label: &'static str,
              hint: &'static str,
              value: &'a str,
              (step, min, max): (&'static str, &'static str, &'static str)| {
            html! {
                let e = errors.within(PricingFormId);
                <Field id={e.id(name)} label={label} hint={hint} error={e.message(name)}>
                    <input
                        class={Input {}}
                        type="number"
                        value={value}
                        step={step}
                        min={min}
                        max={max}
                        {..e.control(name).hint()}
                    >
                </Field>
            }
        };
    html! {
        let e = errors.within(PricingFormId);
        <form
            id={PricingFormId}
            method="post"
            action={url::SavePricing}
            data-patch
            class={(CardPanel {}, CardCompact {}, Section, Horizon)}
        >
            <SubmitsOnChange>
                <div class={Section}>
                    <h2>"Pricing Configuration"</h2>
                    <span class={Saved}>{saved(section.saved)}</span>
                    <Field
                        id={e.id(f.policy)}
                        label="Active Pricing Policy"
                        hint="Percentile uses the product-line settings below. Target horizon applies one median sell-time target across inventory. Profit per day prices each SKU where net proceeds, discounted at the daily return hurdle over its sell time, are highest."
                        error={e.message(f.policy)}
                    >
                        <select class={Select {}} {..e.control(f.policy).hint()}>
                            for (method, label) in [
                                (Method::Percentile, "Configured percentile"),
                                (Method::TargetHorizon, "Target sell horizon"),
                                (Method::ProfitPerDay, "Profit per day"),
                            ] {
                                <option
                                    value={method.as_ref()}
                                    selected={input.policy == method}
                                >
                                    {label}
                                </option>
                            }
                        </select>
                    </Field>
                    <div class={ForHorizon}>
                        {number(f.horizon_days, "Target Median Sell Time (days)", "Calibrate this value from the complete inventory portfolio; continuous pricing keeps it fixed as markets move.", &input.horizon_days, ("0.1", "0.1", ""))}
                    </div>
                    <h3>"Profit per day settings"</h3>
                    <p class={muted()}>
                        "Used by the profit-per-day policy and by the inventory strategy dashboard's profit-per-day row."
                    </p>
                    <div class={Row}>
                        {number(f.daily_return_hurdle, "Daily return hurdle", "Fraction of capital earned per day when proceeds are redeployed; 0.005 is 0.5% per day", &input.daily_return_hurdle, ("0.001", "", ""))}
                        {number(f.relative_overhead, "Relative overhead", "Share of each sale lost to fees", &input.relative_overhead, ("0.01", "0", ""))}
                        {number(f.static_overhead_per_unit, "Static overhead per unit", "Dollars lost per unit sold", &input.static_overhead_per_unit, ("0.05", "0", ""))}
                    </div>
                    {number(f.default_percentile, "Default Percentile", "Default percentile for pricing calculations", &input.default_percentile, ("any", "0", "100"))}
                    <div class={Row}>
                        {number(f.min_percentile, "Min Percentile", "", &input.min_percentile, ("any", "0", "100"))}
                        {number(f.max_percentile, "Max Percentile", "", &input.max_percentile, ("any", "0", "100"))}
                    </div>
                    {number(f.percentile_step, "Percentile Step", "Step size for percentile calculations", &input.percentile_step, ("any", "1", "20"))}
                    <Field
                        id={e.id(f.skip_prefix)}
                        label="Skip Prefix"
                        hint="Prefix to identify items to skip during processing"
                        error={e.message(f.skip_prefix)}
                    >
                        <input
                            class={Input {}}
                            value={&input.skip_prefix}
                            {..e.control(f.skip_prefix).hint()}
                        >
                    </Field>
                    <div class={Row}>
                        {number(f.min_price_multiplier, "Min Price Multiplier", "Multiplier for minimum price calculation", &input.min_price_multiplier, ("any", "0", "2"))}
                        {number(f.min_price_constant, "Min Price Constant", "Constant added to minimum price", &input.min_price_constant, ("any", "0", "1"))}
                    </div>
                    <fieldset class={Row}>
                        <legend>"Success Rate Thresholds"</legend>
                        {number(f.success_rate_low, "Low Threshold", "", &input.success_rate_low, ("any", "0", "100"))}
                        {number(f.success_rate_high, "High Threshold", "", &input.success_rate_high, ("any", "0", "100"))}
                    </fieldset>
                </div>
            </SubmitsOnChange>
            <noscript>
                <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>
                    "Save pricing"
                </button>
            </noscript>
        </form>
    }
}

/// The default percentile, the form that adds a product line, and the product lines priced
/// differently, each with its Remove button. Every post to it answers the whole section.
#[component(css = ConfigurationScreen)]
pub fn ProductLinesSection<'a>(lines: &'a Lines<'a>) -> impl Patch {
    let (d, a) = (DefaultPercentileInput::FIELDS, AddLineInput::FIELDS);
    let name = |id: i32| {
        lines
            .names
            .iter()
            .find(|(line, _)| *line == id)
            .map_or_else(|| format!("Product Line {id}"), |(_, name)| name.clone())
    };
    // The product lines not configured yet.
    let available = move || {
        lines
            .names
            .iter()
            .filter(|(id, _)| !lines.stored.settings.contains_key(id))
            .map(|(id, name)| Choice::new(*id, name.as_str()))
            .collect::<Vec<_>>()
    };
    html! {
        let e = lines.errors.within(ProductLinesId);
        let choices = available();
        let aria = e.aria(a.product_line);
        let picker = Picker {
            value: lines.add.product_line,
            attrs: &aria,
            ..Picker::new(ProductLinePickId, a.product_line, "Search product lines...", "No matches", &choices)
        };
        let (min, max) = (lines.percentiles.0.to_string(), lines.percentiles.1.to_string());
        let hurdle = lines.default_hurdle.to_string();
        <section id={ProductLinesId} class={(CardPanel {}, CardCompact {}, Section)}>
            <h2>"Product Line Pricing"</h2>
            <p class={muted()}>
                "Configure a different percentile or profit-per-day hurdle for specific product lines. You can also skip product lines entirely. Non-configured product lines use the defaults."
            </p>
            match lines.said {
                Some(said) => <p role="status" class={Saved}>{said}</p>,
                None => {}
            }
            <form method="post" action={url::SaveDefaultPercentile} data-patch>
                <SubmitsOnChange>
                    <Field
                        id={e.id(d.default_percentile)}
                        label="Default Percentile for Non-Configured Lines"
                        hint="Percentile used for product lines not explicitly configured below"
                        error={e.message(d.default_percentile)}
                    >
                        <input
                            class={Input {}}
                            type="number"
                            value={&lines.default.default_percentile}
                            min={&min}
                            max={&max}
                            {..e.control(d.default_percentile).hint()}
                        >
                    </Field>
                </SubmitsOnChange>
                <noscript>
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Save default percentile"
                    </button>
                </noscript>
            </form>
            <form method="post" action={url::AddProductLine} data-patch class={Add}>
                <div class={Section}>
                    <label for={ProductLinePickId}>"Select Product Line"</label>
                    <ComboBox field={&picker} />
                    {e.message(a.product_line)}
                </div>
                <Field
                    id={e.id(a.percentile)}
                    label="Percentile"
                    hint=""
                    error={e.message(a.percentile)}
                >
                    <input
                        class={Input {}}
                        type="number"
                        value={&lines.add.percentile}
                        min={&min}
                        max={&max}
                        {..e.control(a.percentile)}
                    >
                </Field>
                <Field
                    id={e.id(a.daily_return_hurdle)}
                    label="Daily return hurdle"
                    hint="Blank uses the default"
                    error={e.message(a.daily_return_hurdle)}
                >
                    <input
                        class={Input {}}
                        type="number"
                        step="0.001"
                        value={&lines.add.daily_return_hurdle}
                        placeholder={&hurdle}
                        {..e.control(a.daily_return_hurdle).hint()}
                    >
                </Field>
                <Checkbox label="Skip">
                    <input type="checkbox" name={a.skip} checked={lines.add.skip}>
                </Checkbox>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Add"
                </button>
            </form>
            if lines.stored.settings.is_empty() {
                <Alert variant={AlertVariant::Info}>
                    "No product lines configured. All product lines will use the default percentile ("
                    {lines.stored.default_percentile}
                    ")."
                </Alert>
            } else {
                <Table layout={TableLayout::Scroll}>
                    <table class={Lines}>
                        <thead>
                            <tr>
                                <th>"Product Line"</th>
                                <th>"Percentile"</th>
                                <th>"Daily return hurdle"</th>
                                <th>"Skip"</th>
                                <th>"Actions"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (id, setting) in &lines.stored.settings {
                                <tr id={ProductLineRowId(*id)}>
                                    <td>{name(*id)}</td>
                                    if setting.skip {
                                        <td>"—"</td>
                                        <td>"—"</td>
                                    } else {
                                        <td>{setting.percentile}</td>
                                        <td>
                                            {setting.daily_return_hurdle.map_or_else(|| "—".to_owned(), |h| h.to_string())}
                                        </td>
                                    }
                                    <td>{if setting.skip { "Yes" } else { "No" }}</td>
                                    <td>
                                        <form
                                            method="post"
                                            action={url::RemoveProductLine { id: *id }}
                                            data-patch
                                        >
                                            <button
                                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                                                aria-label={("Remove ", name(*id).as_str())}
                                            >
                                                "Remove"
                                            </button>
                                        </form>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </section>
    }
}

#[component(css = ConfigurationScreen)]
pub fn SnapsForm<'a>(section: &'a Section<'a, SnapsInput>) -> impl Patch {
    let (input, errors) = (section.input, section.errors);
    let (f, e) = (SnapsInput::FIELDS, errors.within(SnapsFormId));
    html! {
        <form
            id={SnapsFormId}
            method="post"
            action={url::SaveSnaps}
            data-patch
            class={(CardPanel {}, CardCompact {}, Section)}
        >
            <SubmitsOnChange>
                <div class={Section}>
                    <h2>"Shipping Threshold Snaps"</h2>
                    <span class={Saved}>{saved(section.saved)}</span>
                    <p class={muted()}>
                        "Under the profit-per-day policy, a price just above $5, $50, or $250 is compared with one cent under. Each price is valued after the shipping it is expected to cost, learned from recent orders and the baskets buyers place, and discounted over its forecast sell time. The lower price is listed only when it returns more and stays at or above the price floor."
                    </p>
                    <Switch label="Snap prices just under shipping thresholds">
                        <input
                            type="checkbox"
                            role="switch"
                            name={f.enabled}
                            checked={input.enabled}
                        >
                    </Switch>
                    <div class={row(Space::_3)}>
                        for threshold in SHIPPING_THRESHOLDS {
                            let label = format!("${threshold} (list at ${:.2})", f64::from(threshold) - 0.01);
                            <Checkbox label={&label}>
                                <input
                                    type="checkbox"
                                    name={f.thresholds}
                                    value={threshold}
                                    checked={input.thresholds.contains(&threshold)}
                                >
                            </Checkbox>
                        }
                    </div>
                    <div class={Row}>
                        <Field
                            id={e.id(f.snap_range)}
                            label="Snap range"
                            hint="A price up to this fraction above a threshold may be snapped under it; 0.1 is 10%"
                            error={e.message(f.snap_range)}
                        >
                            <input
                                class={Input {}}
                                type="number"
                                step="0.01"
                                min="0.01"
                                max="0.5"
                                value={&input.snap_range}
                                {..e.control(f.snap_range).hint()}
                            >
                        </Field>
                        <Field
                            id={e.id(f.evidence_window_days)}
                            label="Learn shipping costs from"
                            hint="Trailing orders the shipping cost model learns from"
                            error={e.message(f.evidence_window_days)}
                        >
                            <select class={Select {}} {..e.control(f.evidence_window_days).hint()}>
                                for days in EVIDENCE_WINDOWS {
                                    <option
                                        value={days}
                                        selected={input.evidence_window_days == days}
                                    >
                                        "Last "{days}" days"
                                    </option>
                                }
                            </select>
                        </Field>
                    </div>
                </div>
            </SubmitsOnChange>
            <noscript>
                <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>
                    "Save snaps"
                </button>
            </noscript>
        </form>
    }
}

#[component(css = ConfigurationScreen)]
pub fn SupplyForm<'a>(section: &'a Section<'a, SupplyInput>) -> impl Patch {
    let input = section.input;
    let f = SupplyInput::FIELDS;
    html! {
        <form
            id={SupplyFormId}
            method="post"
            action={url::SaveSupply}
            data-patch
            class={(CardPanel {}, CardCompact {}, Section, Supply)}
        >
            <SubmitsOnChange>
                <div class={Section}>
                    <h2>"Supply Analysis Configuration"</h2>
                    <span class={Saved}>{saved(section.saved)}</span>
                    <p class={muted()}>
                        "Configure market-adjusted time-to-sell calculations. When enabled, this feature fetches current market listings to provide more accurate time-to-sell estimates by considering market supply alongside historical sales data."
                        <br>
                        <strong>"Note:"</strong>
                        " Enabling this feature significantly increases network calls (1 listing API call per SKU)."
                    </p>
                    <Switch label="Enable Supply Analysis">
                        <input
                            type="checkbox"
                            role="switch"
                            name={f.enabled}
                            checked={input.enabled}
                            data-enables
                        >
                    </Switch>
                    <div class={(ForSupply, Section)}>
                        <Alert variant={AlertVariant::Info}>
                            "Supply analysis is enabled. This will increase processing time and network usage but provides more accurate time-to-sell estimates by analyzing current market supply."
                        </Alert>
                        <Switch label="Include Unverified Sellers">
                            <input
                                type="checkbox"
                                role="switch"
                                name={f.include_unverified_sellers}
                                checked={input.include_unverified_sellers}
                            >
                        </Switch>
                        <p class={muted()}>
                            "When enabled, includes listings from all sellers in the analysis. When disabled, only verified sellers are considered (recommended for quality)."
                        </p>
                    </div>
                </div>
            </SubmitsOnChange>
            <noscript>
                <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>
                    "Save supply analysis"
                </button>
            </noscript>
        </form>
    }
}
