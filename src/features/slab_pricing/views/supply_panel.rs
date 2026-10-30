use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::slab_pricing::{
        actions::{CancelInput, NextSourcePageInput, RefreshInput},
        identity::words,
        page::{Place, Screen},
        recommendation::amount,
        research::EvidenceStatus,
        supply::{Context, ROWS, Supply, money},
        url::{self, Choice},
        views::{KeptChoice, Problem},
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

#[derive(Id)]
struct SupplyBodyId;

/// Asks on unsold listings for the slab researched, shown on request. Context only: it never
/// changes the recommendation.
#[component(css)]
pub fn SupplyPanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let shown = choice.shows_supply();
    let toggled = Choice {
        supply: (!shown).then_some(true),
        ..choice.supply_source(None, Vec::new())
    };
    html! {
        <section class={(panel(), Stack, SupplyPanel)} aria-labelledby="slab-supply">
            <div class={(Line, Head)}>
                <h2 id="slab-supply">"Supply context"</h2>
                <a href={url::SlabPricing::at(&toggled)}>
                    if shown { "Hide supply context" } else { "Show supply context" }
                </a>
            </div>
            if shown {
                <p class={muted()}>
                    "Asking prices describe unsold listings. They do not change the recommendation or establish a price floor or ceiling."
                </p>
                <SupplyControls screen={screen} />
                <Problem at={Place::Supply} why={screen.problem_at(Place::Supply)} />
                match &screen.supply {
                    Some(Err(why)) => <Notice tone={Tone::Warning}>{why}</Notice>,
                    _ => <SupplyBody screen={screen} t={t} />,
                }
                <Notice tone={Tone::Info}>
                    "Seller order outcomes are not connected. Sale probability and time to sell remain unavailable; listing disappearance is not a sale."
                </Notice>
            }
        </section>
    }
}

/// Refreshing the supply, reloading what is saved, and choosing the source shown.
#[component(css = SupplyPanel)]
fn SupplyControls<'a>(screen: &'a Screen) -> impl Render {
    let choice = &screen.choice;
    let r = RefreshInput::FIELDS;
    let f = Choice::FIELDS;
    let supply = screen.supply.as_ref().and_then(|s| s.as_ref().ok());
    let record = screen.record.as_ref();
    html! {
        <div class={Line}>
            if let Some(record) = record {
                <form
                    method="post"
                    action={url::RefreshSupply { choice: choice.clone() }}
                    data-patch
                >
                    <input type="hidden" name={r.id} value={&record.id}>
                    <input type="hidden" name={r.revision} value={record.revision}>
                    <button>"Refresh supply"</button>
                </form>
            }
            <a href={url::SlabPricing::at(choice)}>"Reload saved supply"</a>
            if let Some(supply) = supply.filter(|s| !s.statuses.is_empty()) {
                <form method="get" action={url::SlabPricing::at(&Choice::default())} class={Line}>
                    <KeptChoice choice={choice} except={&[f.source, f.rows, f.sources]} />
                    <Field label="Supply source" hint="">
                        <select name={f.source}>
                            for status in &supply.statuses {
                                <option
                                    value={&status.key}
                                    selected={supply.selected_key.as_deref() == Some(status.key.as_str())}
                                >
                                    {source_name(status)}" · "{words(&status.state)}
                                </option>
                            }
                        </select>
                    </Field>
                    <button>"Show source"</button>
                </form>
            }
        </div>
    }
}

/// `Alt`, or the eBay page a supply source is.
fn source_name(status: &EvidenceStatus) -> String {
    match status.spec.kind.as_str() {
        "alt-supply" => "Alt".into(),
        _ => match (status.spec.offset, status.spec.limit) {
            (Some(offset), Some(limit)) if limit > 0 => format!("eBay page {}", offset / limit + 1),
            _ => "eBay page 1".into(),
        },
    }
}

/// The supply's refreshes and the source shown. Read again with the evidence while a refresh
/// is on its way.
#[component(css = SupplyPanel)]
pub fn SupplyBody<'a>(screen: &'a Screen, t: Msg) -> impl Patch {
    let supply = screen.supply.as_ref().and_then(|s| s.as_ref().ok());
    let changed = supply.is_some_and(|s| {
        screen
            .record
            .as_ref()
            .is_some_and(|r| r.revision != s.identity_revision)
    });
    let choice = &screen.choice;
    let seller = screen.supply_seller().to_owned();
    let visitor = screen.visitor;
    let c = CancelInput::FIELDS;
    html! {
        <div id={SupplyBodyId} class={Stack} aria-live="polite">
            if changed {
                <Notice tone={Tone::Warning}>
                    "The identity changed. Reopen the certificate before using this supply context."
                </Notice>
            }
            if let Some(supply) = supply {
                for status in &supply.statuses {
                    <div class={Line}>
                        <span>
                            {words(&status.spec.kind)}": "{words(&status.state)}
                            if let Some(code) = &status.error_code {
                                " · "{words(code)}
                            }
                        </span>
                        if status.pending() {
                            <form
                                method="post"
                                action={url::Cancel { choice: choice.clone() }}
                                data-patch
                            >
                                <input type="hidden" name={c.key} value={&status.key}>
                                <input type="hidden" name={c.run} value={&status.run_id}>
                                <button>"Cancel supply refresh"</button>
                            </form>
                        }
                    </div>
                }
                <p class={muted()}>
                    "Excludes "{supply.known_own_listings}" known item IDs imported for "{&seller}
                    ". Import missing inventory before treating potential matches as competitors."
                </p>
                match supply.context.as_ref().filter(|_| !changed) {
                    None => {
                        if !changed {
                            <Notice tone={Tone::Info}>
                                "No saved active-supply response. Refresh to request one."
                            </Notice>
                        }
                    }
                    Some(context) => {
                        <SupplyContext
                            supply={supply}
                            context={context}
                            choice={choice}
                            t={t}
                            visitor={visitor}
                        />
                    }
                }
            }
        </div>
    }
}

/// The source shown: its counts and lowest asks, a page of its listings, and what changed since
/// the observation before it.
#[component(css = SupplyPanel)]
fn SupplyContext<'a>(
    supply: &'a Supply,
    context: &'a Context,
    choice: &'a Choice,
    t: Msg,
    visitor: Visitor,
) -> impl Render {
    let at = |when: &str| when.parse::<DateTime<Utc>>().ok();
    let captured = at(&context.captured_at);
    let page = supply.page.as_ref();
    let first = page.map_or(0, |p| p.offset);
    let shown = context.rows.len() as u32;
    let previous_rows = (first > 0).then(|| Choice {
        rows: Some(first.saturating_sub(ROWS)).filter(|r| *r > 0),
        ..choice.clone()
    });
    let next_rows = page.and_then(|p| p.next_offset).map(|next| Choice {
        rows: Some(next),
        ..choice.clone()
    });
    let n = NextSourcePageInput::FIELDS;
    let changes = supply.changes.as_ref();
    let from = changes.and_then(|c| at(&c.observed_from));
    let through = changes.and_then(|c| at(&c.observed_through));
    html! {
        if context.stale {
            <Notice tone={Tone::Warning}>
                "This supply snapshot is stale or its latest refresh failed. Old asks remain visible but are excluded from competition counts."
            </Notice>
        }
        <p>
            {context.equivalent_listings}" equivalent listings · "{context.potential_listings}
            " potential matches · "{context.excluded_listings}" excluded"
        </p>
        <p class={muted()}>
            "Lowest equivalent delivered ask: "{amount(context.lowest_equivalent_delivered_ask)}
            " · Lowest potential delivered ask: "{amount(context.lowest_potential_delivered_ask)}
        </p>
        <p class={muted()}>
            if let Some(captured) = captured {
                "Observed "
                {t.date_time(captured, DateStyle::Short, TimeStyle::Medium).zone(visitor)}" · "
            }
            {context.reported_count}" listings in this response · "
            if supply.source_has_more_pages {
                "More source pages exist; this is a partial page."
            } else {
                "Search coverage is incomplete."
            }
        </p>
        <div class={Scroll}>
            <table class={Table} aria-label="Active supply">
                <thead>
                    <tr>
                        <th>"Active listing"</th>
                        <th>"Item ask / bid"</th>
                        <th>"Shipping"</th>
                        <th>"Delivered (USD)"</th>
                        <th>"Listing age"</th>
                        <th>"Comparison"</th>
                        <th>"Review reasons"</th>
                    </tr>
                </thead>
                <tbody>
                    for row in &context.rows {
                        <tr key={&row.key}>
                            <td>
                                match row.listing.source_url.as_deref().filter(|u| u.starts_with("https://")) {
                                    Some(href) => {
                                        <a href={href} target="_blank" rel="noreferrer">
                                            {row.listing.title.as_deref().unwrap_or(&row.listing.provider_id)}
                                        </a>
                                    }
                                    None => {
                                        {row.listing.title.as_deref().unwrap_or(&row.listing.provider_id)}
                                    }
                                }
                            </td>
                            <td>
                                {money(row.listing.price.as_ref())}" ("{&row.listing.price_kind}")"
                            </td>
                            <td>{money(row.listing.shipping.as_ref())}</td>
                            <td>{amount(row.delivered_ask)}</td>
                            <td>{row.age()}</td>
                            <td>{words(&row.status)}</td>
                            <td>
                                {row.reasons.iter().map(|r| words(r)).collect::<Vec<_>>().join("; ")}
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
        <nav class={Line} aria-label="Supply pages">
            if let Some(back) = choice.previous_source() {
                <a href={url::SlabPricing::at(&back)}>"Previous source page"</a>
            }
            if let Some(revision) = supply.selected_revision().filter(|_| supply.source_has_more_pages) {
                <form
                    method="post"
                    action={url::NextSourcePage { choice: choice.clone() }}
                    data-patch
                >
                    <input type="hidden" name={n.revision} value={revision}>
                    <button>"Fetch next source page"</button>
                </form>
            }
            match &previous_rows {
                Some(back) => <a href={url::SlabPricing::at(back)}>"Previous supply rows"</a>,
                None => <span class={muted()}>"Previous supply rows"</span>,
            }
            <span>
                {first + shown.min(1)}"–"{first + shown}" of "{page.map_or(0, |p| p.total)}
            </span>
            match &next_rows {
                Some(next) => <a href={url::SlabPricing::at(next)}>"Next supply rows"</a>,
                None => <span class={muted()}>"Next supply rows"</span>,
            }
        </nav>
        <p class={muted()}>
            "Listing age is not time at the current price. Seller identity and available quantity remain unknown when the source omits them."
        </p>
        match changes {
            Some(changes) => {
                <p class={muted()}>
                    "Observed from "
                    if let Some(from) = from {
                        {t.date_time(from, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    }
                    " through "
                    if let Some(through) = through {
                        {t.date_time(through, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                    }
                    ": "{changes.changes.len()}
                    " changes. Continuous exposure between observations is unknown."
                </p>
                <ul class={Changes}>
                    for change in changes.changes.iter().take(20) {
                        <li>{&change.key}": "{words(&change.kind)}". No sale inferred."</li>
                    }
                </ul>
            }
            None => {
                <p class={muted()}>
                    "One recorded observation cannot establish exposure or sale rate."
                </p>
            }
        }
    }
}
