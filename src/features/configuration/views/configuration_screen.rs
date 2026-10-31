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
    layout::{Field, Notice, SubmitsOnChange, Tone},
    theme::*,
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
    reset: bool,
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
                <Notice tone={Tone::Warning}>
                    <strong>"Authentication Required:"</strong>
                    " You haven't configured your TCGPlayer auth cookie yet. "
                    <a href={http_configuration::url::HttpSettings { done: None }}>
                        "Configure HTTP Settings"
                    </a>
                </Notice>
            }
            if reset {
                <Notice tone={Tone::Done}>"Configuration reset to defaults"</Notice>
            }
            <PricingForm section={pricing} />
            <ProductLinesSection lines={lines} />
            <SnapsForm section={snaps} />
            <ReportPanels reports={reports} />
            <SupplyForm section={supply} />
            <section class={(panel(), Section)}>
                <h2>"Reset Configuration"</h2>
                <p class={muted()}>
                    "Reset all configuration settings back to their original default values."
                </p>
                <details>
                    <summary>"Reset to Defaults"</summary>
                    <form method="post" action={url::ResetConfiguration}>
                        <Notice tone={Tone::Warning}>
                            "This resets every setting on this page. It cannot be undone."
                        </Notice>
                        <button class={Danger}>"Confirm Reset to Defaults"</button>
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
    let number = move |name: FieldName<String>,
                       value: &'a str,
                       step: &'static str,
                       min: &'static str,
                       max: &'static str| {
        let e = errors.within(PricingFormId);
        html! {
            <input
                type="number"
                name={name}
                value={value}
                step={step}
                min={min}
                max={max}
                {..e.aria(name)}
            >
            {e.message(name)}
        }
    };
    html! {
        <form
            id={PricingFormId}
            method="post"
            action={url::SavePricing}
            data-patch
            class={(panel(), Section, Horizon)}
        >
            <SubmitsOnChange>
                <div class={Section}>
                    <h2>"Pricing Configuration"</h2>
                    <span class={Saved}>{saved(section.saved)}</span>
                    <Field
                        label="Active Pricing Policy"
                        hint="Percentile uses the product-line settings below. Target horizon applies one median sell-time target across inventory. Profit per day prices each SKU where net proceeds, discounted at the daily return hurdle over its sell time, are highest."
                    >
                        <select name={f.policy}>
                            for (method, label) in [
                                (Method::Percentile, "Configured percentile"),
                                (Method::TargetHorizon, "Target sell horizon"),
                                (Method::ProfitPerDay, "Profit per day"),
                            ] {
                                <option value={method.as_ref()} selected={input.policy == method}>
                                    {label}
                                </option>
                            }
                        </select>
                    </Field>
                    <div class={ForHorizon}>
                        <Field
                            label="Target Median Sell Time (days)"
                            hint="Calibrate this value from the complete inventory portfolio; continuous pricing keeps it fixed as markets move."
                        >
                            {number(f.horizon_days, &input.horizon_days, "0.1", "0.1", "")}
                        </Field>
                    </div>
                    <h3>"Profit per day settings"</h3>
                    <p class={muted()}>
                        "Used by the profit-per-day policy and by the inventory strategy dashboard's profit-per-day row."
                    </p>
                    <div class={Row}>
                        <Field
                            label="Daily return hurdle"
                            hint="Fraction of capital earned per day when proceeds are redeployed; 0.005 is 0.5% per day"
                        >
                            {number(f.daily_return_hurdle, &input.daily_return_hurdle, "0.001", "", "")}
                        </Field>
                        <Field label="Relative overhead" hint="Share of each sale lost to fees">
                            {number(f.relative_overhead, &input.relative_overhead, "0.01", "0", "")}
                        </Field>
                        <Field label="Static overhead per unit" hint="Dollars lost per unit sold">
                            {number(f.static_overhead_per_unit, &input.static_overhead_per_unit, "0.05", "0", "")}
                        </Field>
                    </div>
                    <Field
                        label="Default Percentile"
                        hint="Default percentile for pricing calculations"
                    >
                        {number(f.default_percentile, &input.default_percentile, "any", "0", "100")}
                    </Field>
                    <div class={Row}>
                        <Field label="Min Percentile" hint="">
                            {number(f.min_percentile, &input.min_percentile, "any", "0", "100")}
                        </Field>
                        <Field label="Max Percentile" hint="">
                            {number(f.max_percentile, &input.max_percentile, "any", "0", "100")}
                        </Field>
                    </div>
                    <Field label="Percentile Step" hint="Step size for percentile calculations">
                        {number(f.percentile_step, &input.percentile_step, "any", "1", "20")}
                    </Field>
                    <Field
                        label="Skip Prefix"
                        hint="Prefix to identify items to skip during processing"
                    >
                        <input name={f.skip_prefix} value={&input.skip_prefix}>
                    </Field>
                    <div class={Row}>
                        <Field
                            label="Min Price Multiplier"
                            hint="Multiplier for minimum price calculation"
                        >
                            {number(f.min_price_multiplier, &input.min_price_multiplier, "any", "0", "2")}
                        </Field>
                        <Field label="Min Price Constant" hint="Constant added to minimum price">
                            {number(f.min_price_constant, &input.min_price_constant, "any", "0", "1")}
                        </Field>
                    </div>
                    <fieldset class={Row}>
                        <legend>"Success Rate Thresholds"</legend>
                        <Field label="Low Threshold" hint="">
                            {number(f.success_rate_low, &input.success_rate_low, "any", "0", "100")}
                        </Field>
                        <Field label="High Threshold" hint="">
                            {number(f.success_rate_high, &input.success_rate_high, "any", "0", "100")}
                        </Field>
                    </fieldset>
                </div>
            </SubmitsOnChange>
            <noscript><button>"Save pricing"</button></noscript>
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
            ..Picker::new("product-line-pick", a.product_line, "Search product lines...", "No matches", &choices)
        };
        let (min, max) = (lines.percentiles.0.to_string(), lines.percentiles.1.to_string());
        let hurdle = lines.default_hurdle.to_string();
        <section id={ProductLinesId} class={(panel(), Section)}>
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
                        label="Default Percentile for Non-Configured Lines"
                        hint="Percentile used for product lines not explicitly configured below"
                    >
                        <input
                            type="number"
                            name={d.default_percentile}
                            value={&lines.default.default_percentile}
                            min={&min}
                            max={&max}
                            {..e.aria(d.default_percentile)}
                        >
                        {e.message(d.default_percentile)}
                    </Field>
                </SubmitsOnChange>
                <noscript><button>"Save default percentile"</button></noscript>
            </form>
            <form method="post" action={url::AddProductLine} data-patch class={Add}>
                <div class={Section}>
                    <label for={ProductLinePickId}>"Select Product Line"</label>
                    <ComboBox field={&picker} />
                    {e.message(a.product_line)}
                </div>
                <Field label="Percentile" hint="">
                    <input
                        type="number"
                        name={a.percentile}
                        value={&lines.add.percentile}
                        min={&min}
                        max={&max}
                        {..e.aria(a.percentile)}
                    >
                    {e.message(a.percentile)}
                </Field>
                <Field label="Daily return hurdle" hint="Blank uses the default">
                    <input
                        type="number"
                        step="0.001"
                        name={a.daily_return_hurdle}
                        value={&lines.add.daily_return_hurdle}
                        placeholder={&hurdle}
                        {..e.aria(a.daily_return_hurdle)}
                    >
                    {e.message(a.daily_return_hurdle)}
                </Field>
                <label class={Switch}>
                    <input type="checkbox" name={a.skip} checked={lines.add.skip}>
                    "Skip"
                </label>
                <button data-primary>"Add"</button>
            </form>
            if lines.stored.settings.is_empty() {
                <Notice tone={Tone::Info}>
                    "No product lines configured. All product lines will use the default percentile ("
                    {lines.stored.default_percentile}
                    ")."
                </Notice>
            } else {
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
                                        <button aria-label={("Remove ", name(*id).as_str())}>
                                            "Remove"
                                        </button>
                                    </form>
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
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
            class={(panel(), Section)}
        >
            <SubmitsOnChange>
                <div class={Section}>
                    <h2>"Shipping Threshold Snaps"</h2>
                    <span class={Saved}>{saved(section.saved)}</span>
                    <p class={muted()}>
                        "Under the profit-per-day policy, a price just above $5, $50, or $250 is compared with one cent under. Each price is valued after the shipping it is expected to cost, learned from recent orders and the baskets buyers place, and discounted over its forecast sell time. The lower price is listed only when it returns more and stays at or above the price floor."
                    </p>
                    <label class={Switch}>
                        <input type="checkbox" name={f.enabled} checked={input.enabled}>
                        "Snap prices just under shipping thresholds"
                    </label>
                    <div class={row(Space::_3)}>
                        for threshold in SHIPPING_THRESHOLDS {
                            <label class={Switch}>
                                <input
                                    type="checkbox"
                                    name={f.thresholds}
                                    value={threshold}
                                    checked={input.thresholds.contains(&threshold)}
                                >
                                "$"{threshold}" (list at $"
                                {format!("{:.2}", f64::from(threshold) - 0.01)}")"
                            </label>
                        }
                    </div>
                    <div class={Row}>
                        <Field
                            label="Snap range"
                            hint="A price up to this fraction above a threshold may be snapped under it; 0.1 is 10%"
                        >
                            <input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max="0.5"
                                name={f.snap_range}
                                value={&input.snap_range}
                                {..e.aria(f.snap_range)}
                            >
                            {e.message(f.snap_range)}
                        </Field>
                        <Field
                            label="Learn shipping costs from"
                            hint="Trailing orders the shipping cost model learns from"
                        >
                            <select
                                name={f.evidence_window_days}
                                {..e.aria(f.evidence_window_days)}
                            >
                                for days in EVIDENCE_WINDOWS {
                                    <option
                                        value={days}
                                        selected={input.evidence_window_days == days}
                                    >
                                        "Last "{days}" days"
                                    </option>
                                }
                            </select>
                            {e.message(f.evidence_window_days)}
                        </Field>
                    </div>
                </div>
            </SubmitsOnChange>
            <noscript><button>"Save snaps"</button></noscript>
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
            class={(panel(), Section, Supply)}
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
                    <label class={Switch}>
                        <input
                            type="checkbox"
                            name={f.enabled}
                            checked={input.enabled}
                            data-enables
                        >
                        "Enable Supply Analysis"
                    </label>
                    <div class={(ForSupply, Section)}>
                        <Notice tone={Tone::Info}>
                            "Supply analysis is enabled. This will increase processing time and network usage but provides more accurate time-to-sell estimates by analyzing current market supply."
                        </Notice>
                        <label class={Switch}>
                            <input
                                type="checkbox"
                                name={f.include_unverified_sellers}
                                checked={input.include_unverified_sellers}
                            >
                            "Include Unverified Sellers"
                        </label>
                        <p class={muted()}>
                            "When enabled, includes listings from all sellers in the analysis. When disabled, only verified sellers are considered (recommended for quality)."
                        </p>
                    </div>
                </div>
            </SubmitsOnChange>
            <noscript><button>"Save supply analysis"</button></noscript>
        </form>
    }
}
