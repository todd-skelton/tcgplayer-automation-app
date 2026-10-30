use chrono::{DateTime, Utc};
use corten::{
    i18n::{DateStyle, TimeStyle},
    prelude::*,
};

use crate::{
    features::slab_pricing::{
        actions::{DryRunInput, PrepareInput},
        identity::words,
        inventory::Listing,
        page::{Place, Screen},
        publication::{Plan, Preview, Review, Run, Step},
        recommendation::{Recommendation, amount},
        url::{self, Choice},
        views::Problem,
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
    zone::Visitor,
};

/// The link that shows or hides the price-change review of the listing reviewed, and the review
/// when it is shown.
#[component(css)]
pub fn PublicationPanel<'a>(
    screen: &'a Screen,
    listing: &'a Listing,
    recommendation: &'a Recommendation,
    stale: bool,
    t: Msg,
) -> impl Render {
    let choice = &screen.choice;
    let shown = choice.publication == Some(true);
    let toggle = Choice {
        publication: (!shown).then_some(true),
        steps: None,
        ..choice.clone()
    };
    html! {
        <a href={url::SlabPricing::at(&toggle)} class={Toggle}>
            if shown { "Hide price-change review" } else { "Review listing price change" }
        </a>
        if shown {
            <section class={(panel(), Stack, PublicationPanel)} aria-labelledby="slab-publication">
                <h3 id="slab-publication">"Review a listing price change"</h3>
                <p>
                    "Save the selected ask with this listing and its evidence. A preview uses imported inventory; a live seller read is still required before approval."
                </p>
                <PrepareForm
                    screen={screen}
                    listing={listing}
                    recommendation={recommendation}
                    stale={stale}
                />
                <Problem at={Place::Publication} why={screen.problem_at(Place::Publication)} />
                if let Some(Err(why)) = &screen.publication {
                    <Notice tone={Tone::Warning}>{why}</Notice>
                }
                if stale {
                    <Notice tone={Tone::Warning}>
                        "Recalculate using the current listing and evidence before preparing another price change."
                    </Notice>
                }
                if let Some(Ok(review)) = &screen.publication {
                    if let Some(preview) = &review.preview {
                        <SavedPreview preview={preview} t={t} visitor={screen.visitor} />
                        <DryRun
                            screen={screen}
                            preview={preview}
                            review={review}
                            stale={stale}
                            t={t}
                        />
                    }
                }
                <Notice tone={Tone::Info}>
                    "Seller OAuth and live listing readback are not connected. Publishing is unavailable; saved previews cannot write to eBay."
                </Notice>
            </section>
        }
    }
}

/// The price to review, the calculated ask or the reviewed one, saved as a preview of the listing
/// at the revision shown.
#[component(css = PublicationPanel)]
fn PrepareForm<'a>(
    screen: &'a Screen,
    listing: &'a Listing,
    recommendation: &'a Recommendation,
    stale: bool,
) -> impl Render {
    let f = PrepareInput::FIELDS;
    let reviewed = recommendation.r#override.as_ref();
    let calculated = amount(recommendation.calculation.ask.proposed_item_ask);
    html! {
        <form
            method="post"
            action={url::Prepare { choice: screen.choice.clone() }}
            data-patch
            class={Line}
        >
            {SubmitKey::field(f.submit)}
            <input type="hidden" name={f.revision} value={listing.revision}>
            <input type="hidden" name={f.recommendation} value={&recommendation.id}>
            if let Some(reviewed) = reviewed {
                <input type="hidden" name={f.reviewed_at} value={&reviewed.reviewed_at}>
            }
            <Field label="Price to review" hint="">
                <select name={f.selection}>
                    <option value="calculated" selected={reviewed.is_none()}>
                        "Calculated ask · "{calculated}
                    </option>
                    if let Some(reviewed) = reviewed {
                        <option value="reviewed" selected>
                            "Reviewed ask · "{amount(Some(reviewed.item_price))}
                        </option>
                    }
                </select>
            </Field>
            <button disabled={stale}>"Save price-change preview"</button>
            <a href={url::SlabPricing::at(&screen.choice)}>"Reload preview"</a>
        </form>
    }
}

/// The saved price change: the listing, the old and new price, what it rests on, and whether it
/// needs replacing.
#[component(css = PublicationPanel)]
fn SavedPreview<'a>(preview: &'a Preview, t: Msg, visitor: Visitor) -> impl Render {
    let plan = &preview.plan;
    let inventory = &plan.inventory;
    let saved = parsed(&plan.created_at);
    let expires = parsed(&plan.expires_at);
    let item = format!("https://www.ebay.com/itm/{}", inventory.item_id);
    html! {
        <p>
            <a href={item} target="_blank" rel="noreferrer">{&inventory.snapshot.title}</a>
            " · "{&inventory.seller}
        </p>
        <p>
            {amount(Some(plan.old_price.amount))}" → "{amount(Some(plan.new_price.amount))}
            " ("{plan.change()}") · "{words(&plan.selection)}" ask"
        </p>
        <p class={muted()}>
            "Quantity "{inventory.snapshot.quantity}" · "{words(&inventory.snapshot.format)}
            " · Inventory revision "{inventory.revision}" · Identity revision "
            {plan.identity.revision}
        </p>
        <p class={muted()}>
            "Saved "
            if let Some(at) = saved {
                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
            }
            " · Review expires "
            if let Some(at) = expires {
                {t.date_time(at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
            }
            " · "{plan.evidence.len()}" evidence revisions"
        </p>
        if let Some(reviewed) = &plan.r#override {
            <p class={muted()}>"Review reason: "{&reviewed.note}</p>
        }
        if !plan.flags.is_empty() {
            <Notice tone={Tone::Info}>
                {plan.flags.iter().map(|f| words(f)).collect::<Vec<_>>().join("; ")}
            </Notice>
        }
        if !preview.conflicts.is_empty() {
            <Notice tone={Tone::Warning}>
                "Preview needs replacement: "
                {preview.conflicts.iter().map(|c| words(c)).collect::<Vec<_>>().join("; ")}"."
            </Notice>
        }
        <small class={muted()}>
            "Preview "{&preview.id}" · "{&plan.policy_version}" · "{&plan.version}
        </small>
    }
}

/// The preview's publication checked against the imported inventory and recorded, without
/// writing: its last runs, and the steps of the one asked about.
#[component(css = PublicationPanel)]
fn DryRun<'a>(
    screen: &'a Screen,
    preview: &'a Preview,
    review: &'a Review,
    stale: bool,
    t: Msg,
) -> impl Render {
    let f = DryRunInput::FIELDS;
    let plan: &Plan = &preview.plan;
    let blocked = stale || !preview.conflicts.is_empty() || plan.expired(Utc::now());
    let visitor = screen.visitor;
    let runs: Vec<(&Run, Option<DateTime<Utc>>, Choice)> = review
        .runs
        .iter()
        .map(|run| {
            let steps = Choice {
                steps: Some(run.id.clone()),
                ..screen.choice.clone()
            };
            (run, parsed(&run.created_at), steps)
        })
        .collect();
    let steps: Vec<(&Step, Option<DateTime<Utc>>)> = review
        .steps
        .iter()
        .flat_map(|(_, steps)| steps)
        .map(|step| (step, parsed(&step.created_at)))
        .collect();
    html! {
        <section class={Stack} aria-labelledby="slab-dry-run">
            <h4 id="slab-dry-run">"Publication dry run"</h4>
            <p class={muted()}>
                "Check the saved plan against imported inventory and record the outcome. This does not contact eBay or change a price."
            </p>
            <form
                method="post"
                action={url::DryRun { choice: screen.choice.clone() }}
                data-patch
                class={Line}
            >
                {SubmitKey::field(f.intent)}
                <input type="hidden" name={f.preview} value={&preview.id}>
                <button disabled={blocked}>"Run without writing"</button>
            </form>
            <Problem at={Place::DryRun} why={screen.problem_at(Place::DryRun)} />
            if !runs.is_empty() {
                <ul class={Runs}>
                    for (run, created, shows) in &runs {
                        <li class={Line}>
                            <span>
                                {words(&run.mode)}" · "
                                if run.state == "dry-run" {
                                    "completed without writing"
                                } else {
                                    {words(&run.state)}
                                }
                                if let Some(at) = created {
                                    " · "
                                    {t.date_time(*at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                                }
                                if let Some(reason) = &run.reason {
                                    " · "{words(reason)}
                                }
                            </span>
                            <a href={url::SlabPricing::at(shows)}>"Show steps"</a>
                            if run.resumable() {
                                <form
                                    method="post"
                                    action={url::DryRun { choice: screen.choice.clone() }}
                                    data-patch
                                >
                                    <input type="hidden" name={f.intent} value={&run.id}>
                                    <input type="hidden" name={f.preview} value={&preview.id}>
                                    <button>"Resume dry run"</button>
                                </form>
                            }
                        </li>
                    }
                </ul>
            }
            if !steps.is_empty() {
                <details open>
                    <summary>"Recorded execution steps (latest first)"</summary>
                    <ol class={Runs}>
                        for (step, created) in &steps {
                            <li>
                                {words(&step.state)}
                                if let Some(at) = created {
                                    " · "
                                    {t.date_time(*at, DateStyle::Short, TimeStyle::Medium).zone(visitor)}
                                }
                                if let Some(reason) = &step.reason {
                                    " · "{words(reason)}
                                }
                            </li>
                        }
                    </ol>
                </details>
            }
        </section>
    }
}

/// A time the Node app wrote, when it reads as one.
fn parsed(when: &str) -> Option<DateTime<Utc>> {
    when.parse().ok()
}
