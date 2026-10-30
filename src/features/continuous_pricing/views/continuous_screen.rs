use corten::{
    i18n::{Currency, DateStyle, Minor, TimeStyle},
    prelude::*,
};

use crate::{
    features::continuous_pricing::{
        actions::{ScheduleInput, Screen, SkuInput},
        store::{Item, PAGE_SIZE, RECENT_RUNS, Run, Shown},
        url::{self, View},
        views::said,
    },
    layout::{Field, Notice, SubmitsOnChange, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

const USD: Currency = Currency::new("USD");

fn cents(dollars: f64) -> Minor<i64> {
    Minor((dollars * 100.0).round() as i64)
}

#[derive(Id)]
struct ScheduleProblemId;

/// The schedule form's id: an answer that refuses it replaces it.
#[derive(Id)]
pub struct ScheduleFormId;

/// Why the last post was refused, announced where the actions are.
#[component(css = ContinuousScreen)]
pub fn Problem<'a>(why: Option<&'a str>) -> impl Patch {
    html! {
        <div id={ScheduleProblemId} role="alert">
            if let Some(why) = why {
                <Notice tone={Tone::Warning}>{why}</Notice>
            }
        </div>
    }
}

#[component(css)]
pub fn ContinuousScreen<'a>(
    screen: &'a Screen,
    input: &'a ScheduleInput,
    errors: &'a Errors,
    t: Msg,
) -> impl Render {
    let message = said(&screen.view);
    html! {
        <section class={(Stack, ContinuousScreen)}>
            <header>
                <h1>"Continuous Pricing"</h1>
                <p class={muted()}>
                    "The scheduler refreshes live seller inventory, claims the oldest due SKUs, and creates immutable price-only batches. Each SKU receives its next due time when scheduled, preventing pricing more often than the configured minimum interval."
                </p>
            </header>
            if let Some(message) = &message {
                <Notice tone={Tone::Done}>{message}</Notice>
            }
            <Problem why={screen.problem.as_deref()} />
            <section class={(panel(), Stack)} aria-labelledby="continuous-schedule">
                <h2 id="continuous-schedule">"Schedule"</h2>
                <ScheduleForm screen={screen} input={input} errors={errors} />
                <Actions screen={screen} />
                <p class={muted()}>
                    "Marking inventory due schedules fresh market-data pricing. Saved-curve repricing reuses compatible data and schedules fresh pricing for the rest. Both apply to eligible inventory and run in the background; eligible price changes publish automatically when publishing is enabled."
                </p>
            </section>
            <Snapshot screen={screen} t={t} />
            <Controls screen={screen} />
            <Items screen={screen} t={t} />
            <Runs runs={&screen.runs} t={t} visitor={screen.visitor} />
        </section>
    }
}

/// The schedule: whether it runs, for which seller, and how often.
#[component(css = ContinuousScreen)]
pub fn ScheduleForm<'a>(
    screen: &'a Screen,
    input: &'a ScheduleInput,
    errors: &'a Errors,
) -> impl Patch {
    let (f, e) = (ScheduleInput::FIELDS, errors.within(ScheduleFormId));
    html! {
        <form
            id={ScheduleFormId}
            method="post"
            action={url::SaveSchedule { view: screen.view.quiet() }}
            data-patch
            class={Stack}
        >
            {errors.form_message()}
            <label class={Switch}>
                <input type="checkbox" name={f.enabled} checked={input.enabled}>
                "Enable continuous pricing scheduler"
            </label>
            <Field label="Seller key" hint="">
                <input
                    name={f.seller_key}
                    value={&input.seller_key}
                    maxlength="200"
                    {..e.aria(f.seller_key)}
                >
                {e.message(f.seller_key)}
            </Field>
            <div class={Numbers}>
                <Field label="Minimum pricing interval (minutes)" hint="">
                    <input
                        type="number"
                        min="15"
                        max="43200"
                        name={f.minimum_interval_minutes}
                        value={&input.minimum_interval_minutes}
                        {..e.aria(f.minimum_interval_minutes)}
                    >
                    {e.message(f.minimum_interval_minutes)}
                </Field>
                <Field label="Inventory refresh interval (minutes)" hint="">
                    <input
                        type="number"
                        min="5"
                        max="10080"
                        name={f.inventory_refresh_minutes}
                        value={&input.inventory_refresh_minutes}
                        {..e.aria(f.inventory_refresh_minutes)}
                    >
                    {e.message(f.inventory_refresh_minutes)}
                </Field>
                <Field label="Batch size" hint="">
                    <input
                        type="number"
                        min="1"
                        max="750"
                        name={f.batch_size}
                        value={&input.batch_size}
                        {..e.aria(f.batch_size)}
                    >
                    {e.message(f.batch_size)}
                </Field>
            </div>
            <div><button data-primary>"Save schedule"</button></div>
        </form>
    }
}

/// The work the Node app does on request, each allowed by the schedule as saved.
#[component(css = ContinuousScreen)]
fn Actions<'a>(screen: &'a Screen) -> impl Render {
    let settings = &screen.settings;
    let view = screen.view.quiet();
    let repricable = settings.enabled && screen.status.enabled_in_stock_count > 0;
    html! {
        <div class={Line}>
            <form method="post" action={url::Refresh { view: view.clone() }} data-patch>
                <button disabled={settings.seller_key.is_empty()}>"Refresh inventory now"</button>
            </form>
            <form method="post" action={url::Run { view: view.clone() }} data-patch>
                <button disabled={!settings.enabled}>"Run scheduler cycle"</button>
            </form>
            <form method="post" action={url::ApplyPolicy { view: view.clone() }} data-patch>
                <button disabled={!repricable}>"Reprice all inventory using saved curves"</button>
            </form>
            <form method="post" action={url::MarkDue { view: view.clone() }} data-patch>
                <button disabled={!repricable}>"Mark all inventory due"</button>
            </form>
        </div>
    }
}

/// The tracked inventory at a glance, as of its last refresh.
#[component(css = ContinuousScreen)]
fn Snapshot<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let s = &screen.status;
    let difference = s.market_difference();
    let detail = match difference {
        None => "Market comparison unavailable until the next inventory refresh".to_owned(),
        Some(0.0) => "At market for SKUs where both values are available".to_owned(),
        Some(d) => format!(
            "{:.1}% {} market where both values are available",
            d.abs(),
            if d > 0.0 { "above" } else { "below" }
        ),
    };
    let tone = match difference {
        None => None,
        Some(d) if d >= 0.0 => Some(Above),
        Some(_) => Some(Below),
    };
    let (awaiting, awaiting_units) = s.awaiting_publication;
    let refresh = s.last_refresh.as_ref();
    let visitor = screen.visitor;
    html! {
        <section class={(panel(), Stack)} aria-labelledby="continuous-snapshot">
            <div class={Spread}>
                <div>
                    <h2 id="continuous-snapshot">"Current inventory snapshot"</h2>
                    <p class={muted()}>
                        "Based on the most recently refreshed seller inventory, not real-time availability."
                    </p>
                </div>
                <div class={Line}>
                    <span class={Chip}>{s.enabled_in_stock_count}" enabled"</span>
                    <span class={(Chip, (s.due_count > 0).then_some(Due))}>
                        {s.due_count}" due"
                    </span>
                    <span class={Chip}>{s.inventory_count}" tracked"</span>
                </div>
            </div>
            <div class={Metrics}>
                <div class={Metric}>
                    <span class={muted()}>"Available units"</span>
                    <strong>{t.number(i64::from(s.available_unit_count))}</strong>
                    <small class={muted()}>
                        "Across "{t.number(i64::from(s.in_stock_sku_count))}" in-stock SKUs"
                    </small>
                </div>
                <div class={Metric}>
                    <span class={muted()}>"Current listed value"</span>
                    <strong>{t.money(cents(s.current_inventory_value), USD)}</strong>
                    <small class={tone}>{detail}</small>
                </div>
                <div class={Metric}>
                    <span class={muted()}>"Pricing coverage"</span>
                    <strong>{s.coverage()}</strong>
                    <small class={muted()}>
                        {t.number(i64::from(s.priced_in_stock_sku_count))}" of "
                        {t.number(i64::from(s.in_stock_sku_count))}" in-stock SKUs priced"
                    </small>
                </div>
                <div class={Metric}>
                    <span class={muted()}>"Priced awaiting publication"</span>
                    <strong>{t.number(i64::from(awaiting))}</strong>
                    <small class={muted()}>
                        {t.number(i64::from(awaiting_units))}
                        " new inventory units without confirmed publication"
                    </small>
                </div>
                <div class={Metric}>
                    <span class={muted()}>"Needs review"</span>
                    <strong>{t.number(i64::from(s.needs_review_count))}</strong>
                    <small class={muted()}>"Tracked SKUs with a review warning"</small>
                </div>
                <div class={Metric}>
                    <span class={muted()}>"Current market value"</span>
                    <strong>{t.money(cents(s.current_market_value), USD)}</strong>
                    <small class={muted()}>
                        "Available quantity × market price across "
                        {t.number(i64::from(s.market_value_sku_count))}" in-stock SKUs"
                    </small>
                </div>
            </div>
            <p class={muted()}>
                "Last refresh: "
                match refresh {
                    Some(r) => {
                        {t.date_time(r.at(), DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                        " ("{&r.status}")"
                    }
                    None => "never (not started)",
                }
            </p>
            if let Some(error) = refresh.and_then(|r| r.error_message.as_deref()) {
                <Notice tone={Tone::Warning}>{error}</Notice>
            }
        </section>
    }
}

/// The search and state filter, kept in the address so a review view can be bookmarked.
#[component(css = ContinuousScreen)]
fn Controls<'a>(screen: &'a Screen) -> impl Render {
    let f = View::FIELDS;
    let shown = screen.view.shown();
    html! {
        <section class={(panel(), Stack)} aria-labelledby="continuous-controls">
            <h2 id="continuous-controls">"Inventory controls"</h2>
            <p class={muted()}>
                "Search and manage one bounded page at a time. Filters are retained in the URL so a review view can be bookmarked."
            </p>
            <form
                method="get"
                action={url::ContinuousPricing { view: View::default() }}
                class={Line}
            >
                <Field label="Search SKU, product, set, condition, or product line" hint="">
                    <input type="search" name={f.q} value={screen.view.search()}>
                </Field>
                <Field label="State" hint="">
                    <select name={f.state}>
                        for state in Shown::ALL {
                            <option value={state} selected={state == shown}>{state.label()}</option>
                        }
                    </select>
                </Field>
                <button data-primary>"Apply"</button>
                <a href={url::ContinuousPricing { view: View::default() }}>"Clear"</a>
            </form>
            <p class={muted()}>"Showing "{screen.page.range()}</p>
        </section>
    }
}

/// The page of SKUs, each with its switch, and the pages around it.
#[component(css = ContinuousScreen)]
fn Items<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let page = &screen.page;
    let pages = page.pages();
    let previous = (page.page > 1).then(|| screen.view.at_page(page.page - 1));
    let next = (page.page < pages).then(|| screen.view.at_page(page.page + 1));
    html! {
        <div class={Stack}>
            if page.items.is_empty() {
                <Notice tone={Tone::Info}>"No inventory matches these filters."</Notice>
            }
            for item in &page.items {
                <SkuRow item={item} view={&screen.view} t={t} visitor={screen.visitor} />
            }
            if pages > 1 {
                <nav class={Line} aria-label="Inventory pages">
                    match &previous {
                        Some(previous) => <a href={url::ContinuousPricing { view: previous.clone() }}>
                            "Previous page"
                        </a>,
                        None => <span class={muted()}>"Previous page"</span>,
                    }
                    <span>"Page "{page.page}" of "{pages}" · "{PAGE_SIZE}" per page"</span>
                    match &next {
                        Some(next) => <a href={url::ContinuousPricing { view: next.clone() }}>"Next page"</a>,
                        None => <span class={muted()}>"Next page"</span>,
                    }
                </nav>
            }
        </div>
    }
}

#[component(css = ContinuousScreen)]
fn SkuRow<'a>(item: &'a Item, view: &'a View, t: Msg, visitor: Visitor) -> impl Render {
    let f = SkuInput::FIELDS;
    let price = item
        .current_price
        .map_or_else(|| "unknown".to_owned(), |p| format!("${p:.2}"));
    let (priced, published) = (item.last_priced_at, item.last_published_at);
    let action = || url::SetSku { view: view.quiet() };
    html! {
        <article class={(panel(), SkuCard)}>
            <div class={Spread}>
                <div>
                    <strong>{&item.product_name}</strong>
                    <p class={muted()}>
                        "SKU "{item.sku}" · "{&item.product_line}" · "{&item.set_name}" · "
                        {&item.condition}" · Qty "{item.quantity}" · Price "{price}
                    </p>
                    <p class={muted()}>
                        "Next: "
                        {t.date_time(item.next_price_at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                        " · Last priced: "
                        match priced {
                            Some(at) => {
                                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                            }
                            None => "never",
                        }
                        " · Last published: "
                        match published {
                            Some(at) => {
                                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                            }
                            None => "never",
                        }
                    </p>
                </div>
                <form method="post" action={action()}>
                    <input type="hidden" name={f.sku} value={item.sku}>
                    <SubmitsOnChange>
                        <label class={Switch}>
                            <input
                                type="checkbox"
                                name={f.enabled}
                                checked={item.on()}
                                disabled={!item.pricing_eligible}
                            >
                            {item.state()}
                        </label>
                        <noscript><button>"Save"</button></noscript>
                    </SubmitsOnChange>
                </form>
            </div>
            if let Some(reason) = &item.pause_reason {
                <form method="post" action={action()} class={Review}>
                    <input type="hidden" name={f.sku} value={item.sku}>
                    <input type="hidden" name={f.enabled} value="true">
                    <Notice tone={Tone::Warning}>{reason}</Notice>
                    <button>"Resume"</button>
                </form>
            }
        </article>
    }
}

/// The newest automatic batches.
#[component(css = ContinuousScreen)]
fn Runs<'a>(runs: &'a [Run], t: Msg, visitor: Visitor) -> impl Render {
    html! {
        <section class={(panel(), Stack)} aria-labelledby="continuous-runs">
            <div>
                <h2 id="continuous-runs">"Recent automatic runs"</h2>
                <p class={muted()}>
                    "The newest "{RECENT_RUNS}
                    " continuous batches are shown here. Manual batch history stays in Batch Pricer."
                </p>
            </div>
            if runs.is_empty() {
                <Notice tone={Tone::Info}>"No automatic pricing runs yet."</Notice>
            }
            for run in runs {
                <div class={(Spread, RunRow)}>
                    <span>
                        "Batch "{run.batch_number}" · "{run.item_count}" SKUs · "
                        {t.date_time(run.created_at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    </span>
                    <span class={Line}>
                        <span class={Chip}>{&run.status}</span>
                        if let Some(priority) = run.priority {
                            <span class={(Chip, Outlined)}>
                                if priority > 0 { "New / retry priority" } else { "Routine" }
                            </span>
                        }
                    </span>
                </div>
            }
        </section>
    }
}
