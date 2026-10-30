use corten::prelude::*;
use corten_ui::dialog;

use crate::{
    features::slab_pricing::{
        actions::{CompDecisionInput, FetchCompsInput},
        comps::{Review, Row, money},
        identity::words,
        page::{Place, Screen},
        url::{self, Choice},
        views::Problem,
    },
    layout::{Field, Notice, Tone},
    theme::*,
};

/// The saved comps of the revision reviewed, fifty a page, each screened against the identity
/// researched, and the sale open for a decision.
#[component(css)]
pub fn CompReview<'a>(screen: &'a Screen) -> impl Render {
    let choice = &screen.choice;
    let close = Choice {
        comps: None,
        comps_from: None,
        comp: None,
        ..choice.clone()
    };
    html! {
        <section class={(panel(), Stack, CompReview)} aria-labelledby="slab-comps">
            <div class={Head}>
                <h2 id="slab-comps">"Saved comps"</h2>
                <a href={url::SlabPricing::at(&close)}>"Close comps"</a>
            </div>
            <Problem at={Place::Comps} why={screen.problem_at(Place::Comps)} />
            match &screen.comps {
                Some(Err(why)) => <Notice tone={Tone::Warning}>{why}</Notice>,
                Some(Ok(review)) => {
                    <Comps review={review} choice={choice} />
                    if let Some(index) = choice.comp {
                        if let Some(row) = review.row(index) {
                            <SaleDialog screen={screen} review={review} row={row} />
                        }
                    }
                }
                None => {}
            }
        </section>
    }
}

#[component(css = CompReview)]
fn Comps<'a>(review: &'a Review, choice: &'a Choice) -> impl Render {
    let f = FetchCompsInput::FIELDS;
    let at = |offset: u32| Choice {
        comps_from: (offset > 0).then_some(offset),
        comp: None,
        ..choice.clone()
    };
    let previous = (review.page.offset > 0).then(|| at(review.page.offset.saturating_sub(50)));
    let next = review.page.next_offset.map(at);
    let rows: Vec<(&Row, Choice)> = review
        .rows
        .iter()
        .zip(review.page.offset..)
        .map(|(row, index)| {
            let open = Choice {
                comp: Some(index),
                ..choice.clone()
            };
            (row, open)
        })
        .collect();
    html! {
        <p class={muted()}>
            {review.summary()}
            ". Alt history covers all grades. Comp status is screened against the selected identity; the final calculation also reconciles duplicate events across sources."
        </p>
        if review.active_listings {
            <Notice tone={Tone::Warning}>
                "This response contains active listings instead of sold evidence."
            </Notice>
        }
        if review.rows.is_empty() {
            <Notice tone={Tone::Info}>"No sold observations in this saved response."</Notice>
        }
        <div class={Scroll}>
            <table class={Table} aria-label="Saved comps">
                <thead>
                    <tr>
                        <th>"Details"</th>
                        <th>"Sold date"</th>
                        <th>"Sale"</th>
                        <th>"Grade"</th>
                        <th>"Reported price"</th>
                        <th>"Shipping"</th>
                        <th>"Format"</th>
                        <th>"Comp status"</th>
                    </tr>
                </thead>
                <tbody>
                    for (row, open) in &rows {
                        <tr aria-current={(choice.comp == open.comp).then_some("true")}>
                            <td><a href={url::SlabPricing::at(open)}>"Review"</a></td>
                            <td>{row.sale.date.as_deref().unwrap_or("Unknown")}</td>
                            <td>{row.sale.name()}</td>
                            <td>{row.sale.grade()}</td>
                            <td>{money(row.sale.price.as_ref())}</td>
                            <td>{money(row.sale.shipping.as_ref())}</td>
                            <td>{row.sale.format.as_deref().unwrap_or("Unknown")}</td>
                            <td>{words(&row.status)}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
        <nav class={Line} aria-label="Comp pages">
            match &previous {
                Some(previous) => <a href={url::SlabPricing::at(previous)}>"Previous 50"</a>,
                None => <span class={muted()}>"Previous 50"</span>,
            }
            <span>{review.range()}</span>
            match &next {
                Some(next) => <a href={url::SlabPricing::at(next)}>"Next 50"</a>,
                None => <span class={muted()}>"Next 50"</span>,
            }
            if review.next_source_page {
                <form method="post" action={url::FetchComps { choice: choice.clone() }} data-patch>
                    <input type="hidden" name={f.revision} value={&review.revision_id}>
                    <button>"Fetch next source page"</button>
                </form>
            }
        </nav>
    }
}

/// One sale: where it came from, how it screened, and the operator's decision on it. The address
/// opens it; closing it (the link, Escape, a click outside) goes back to the comps.
#[component(css = CompReview)]
fn SaleDialog<'a>(screen: &'a Screen, review: &'a Review, row: &'a Row) -> impl Render {
    let choice = &screen.choice;
    let closed = Choice {
        comp: None,
        ..choice.clone()
    };
    let close = refs();
    let sale = &row.sale;
    let reasons = if row.reasons.is_empty() {
        "Identity and price passed screening.".to_owned()
    } else {
        row.reasons
            .iter()
            .map(|r| words(r))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let quantity = sale
        .quantity
        .map_or_else(|| "unknown".to_owned(), |q| q.to_string());
    let fetch = FetchCompsInput::FIELDS;
    html! {
        <dialog
            open
            closedby="any"
            aria-labelledby="slab-comp-sale"
            class={Sale}
            on:connect={dialog::modalClosedBy(target, close, signal)}
        >
            <div class={Head}>
                <h3 id="slab-comp-sale">"Review sold evidence"</h3>
                <a ref={close} href={url::SlabPricing::at(&closed)} aria-label="Close">"✕"</a>
            </div>
            <div class={Stack}>
                <p>{sale.name()}</p>
                if let Some(link) = sale.link() {
                    <a href={link} target="_blank" rel="noreferrer">"Open source sale"</a>
                }
                <p class={muted()}>
                    {&sale.provider}" · "{sale.date.as_deref().unwrap_or("Date unknown")}" · "
                    {sale.format.as_deref().unwrap_or("Format unknown")}" · Quantity "{quantity}
                </p>
                <p class={muted()}>{reasons}</p>
                if sale.provider == "alt" && review.kind == "alt-sales" {
                    <form
                        method="post"
                        action={url::FetchComps { choice: choice.clone() }}
                        data-patch
                    >
                        <input type="hidden" name={fetch.revision} value={&review.revision_id}>
                        <input type="hidden" name={fetch.transaction} value={&sale.provider_id}>
                        <button>"Fetch full sale details"</button>
                    </form>
                }
                <Problem
                    at={Place::CompDecision}
                    why={screen.problem_at(Place::CompDecision)}
                />
                if review.can_review {
                    <DecisionForm screen={screen} review={review} row={row} />
                } else {
                    <Notice tone={Tone::Info}>
                        "Return to the confirmed owned grade to save comp decisions."
                    </Notice>
                }
            </div>
        </dialog>
    }
}

#[component(css = CompReview)]
fn DecisionForm<'a>(screen: &'a Screen, review: &'a Review, row: &'a Row) -> impl Render {
    let f = CompDecisionInput::FIELDS;
    let sale = &row.sale;
    let saved = row.decision.as_ref();
    let excluded = saved.is_some_and(|d| d.decision == "exclude");
    let price = saved
        .and_then(|d| d.item_price.as_ref())
        .map_or_else(String::new, |p| p.amount.to_string());
    html! {
        <form
            method="post"
            action={url::DecideComp { choice: screen.choice.clone() }}
            data-patch
            class={Stack}
        >
            <input type="hidden" name={f.revision} value={&review.revision_id}>
            <input type="hidden" name={f.identity_revision} value={review.identity_revision}>
            <input type="hidden" name={f.provider} value={&sale.provider}>
            <input type="hidden" name={f.provider_id} value={&sale.provider_id}>
            <input type="hidden" name={f.date} value={sale.date.as_deref().unwrap_or("")}>
            <Field label="Comp decision" hint="">
                <select name={f.decision}>
                    <option value="accept" selected={!excluded}>"Include after review"</option>
                    <option value="exclude" selected={excluded}>"Exclude"</option>
                </select>
            </Field>
            <Field
                label="Verified item price in USD (optional)"
                hint="Use only an item amount verified from the sale. Shipping and fees remain separate."
            >
                <input type="number" name={f.item_price} value={price} min="0.01" step="0.01">
            </Field>
            <Field label="Review reason" hint="">
                <textarea name={f.note} rows="3" maxlength="1000" required>
                    {saved.map_or("", |d| d.note.as_str())}
                </textarea>
            </Field>
            <p class={muted()}>
                "Including a comp does not override a conflicting card identity or unconfirmed sale outcome."
            </p>
            <button data-primary>"Save decision"</button>
        </form>
    }
}
