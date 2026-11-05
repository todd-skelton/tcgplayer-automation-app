use corten::prelude::*;
use corten_ui::{dialog, rows};

use crate::{
    features::slab_pricing::{
        actions::{CompDecisionInput, FetchCompsInput},
        comps::{CompColumn, Review, Row, money},
        identity::words,
        page::{Place, Screen},
        url::{self, Choice},
        views::Problem,
    },
    row_order,
    theme::*,
    ui::{
        alert::{Alert, AlertVariant},
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        dialog::{Dialog, DialogHeader, DialogSize},
        field::Field,
        input::Input,
        select::Select,
        table::{SortHeader, Table, TableLayout},
        textarea::Textarea,
        visually_hidden::VisuallyHidden,
    },
};

// These forms' answers carry no field errors: a refusal is the place's Problem. Their fields are
// named from the form's id through Within::none.
#[derive(Id)]
struct CompDecisionFormId;

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
        <section
            class={(CardPanel {}, CardCompact {}, Stack, CompReview)}
            aria-labelledby="slab-comps"
        >
            <div class={Head}>
                <h2 id="slab-comps">"Saved comps"</h2>
                <a href={url::SlabPricing::at(&close)}>"Close comps"</a>
            </div>
            <Problem at={Place::Comps} why={screen.problem_at(Place::Comps)} />
            match &screen.comps {
                Some(Err(why)) => <Alert variant={AlertVariant::Warning}>{why}</Alert>,
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
    let mut shown: Vec<(&Row, Choice)> = review
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
    // The page's own rows in the order asked for, as `rows::sort` orders them with the script; a
    // sort link keeps the page.
    let down = choice.comps_down == Some(true);
    if let Some(by) = choice.comps_by {
        row_order::sort(&mut shown, down, |(row, _)| by.key(row));
    }
    let sorted = move |column: CompColumn| {
        let (sort, next_down) = row_order::header(choice.comps_by.as_ref(), down, &column);
        let next = Choice {
            comps_by: Some(column),
            comps_down: next_down.then_some(true),
            comp: None,
            ..choice.clone()
        };
        (sort, url::SlabPricing::at(&next))
    };
    let amount = |m: Option<&crate::features::slab_pricing::comps::Money>| {
        m.map_or_else(String::new, |m| m.amount.to_string())
    };
    html! {
        <p class={muted()}>
            {review.summary()}
            ". Alt history covers all grades. Comp status is screened against the selected identity; the final calculation also reconciles duplicate events across sources."
        </p>
        if review.active_listings {
            <Alert variant={AlertVariant::Warning}>
                "This response contains active listings instead of sold evidence."
            </Alert>
        }
        if review.rows.is_empty() {
            <Alert variant={AlertVariant::Info}>
                "No sold observations in this saved response."
            </Alert>
        }
        <Table layout={TableLayout::Scroll}>
            <table class={Cells}>
                <caption class={VisuallyHidden {}}>
                    "Saved comps. Sorting orders the sales on this page."
                </caption>
                // A hover does not fetch the sorted page, which a click with the script does not
                // use.
                <thead data-no-prefetch>
                    <tr>
                        <th scope="col">"Details"</th>
                        for (column, label) in CompColumn::ALL {
                            let (sort, link) = sorted(column);
                            <SortHeader
                                label={label}
                                sort={sort}
                                link={&link}
                                class={()}
                                on:sort={rows::sort(event, target)}
                            />
                        }
                    </tr>
                </thead>
                <tbody>
                    for (row, open) in &shown {
                        <tr aria-current={(choice.comp == open.comp).then_some("true")}>
                            <td><a href={url::SlabPricing::at(open)}>"Review"</a></td>
                            <td data-sort={row.sale.date.as_deref().unwrap_or("")}>
                                {row.sale.date.as_deref().unwrap_or("Unknown")}
                            </td>
                            <td>{row.sale.name()}</td>
                            <td>{row.sale.grade()}</td>
                            <td data-sort={amount(row.sale.price.as_ref())}>
                                {money(row.sale.price.as_ref())}
                            </td>
                            <td data-sort={amount(row.sale.shipping.as_ref())}>
                                {money(row.sale.shipping.as_ref())}
                            </td>
                            <td data-sort={row.sale.format.as_deref().unwrap_or("")}>
                                {row.sale.format.as_deref().unwrap_or("Unknown")}
                            </td>
                            <td>{words(&row.status)}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </Table>
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
                    <button
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                    >
                        "Fetch next source page"
                    </button>
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
            class={Dialog { size: DialogSize::Lg }}
            on:connect={dialog::modalClosedBy(target, close, signal)}
        >
            <div class={DialogHeader {}}>
                <h3 id="slab-comp-sale">"Review sold evidence"</h3>
                <a
                    ref={close}
                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    href={url::SlabPricing::at(&closed)}
                >
                    "Close"
                </a>
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
                        <button
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                        >
                            "Fetch full sale details"
                        </button>
                    </form>
                }
                <Problem
                    at={Place::CompDecision}
                    why={screen.problem_at(Place::CompDecision)}
                />
                if review.can_review {
                    <DecisionForm screen={screen} review={review} row={row} />
                } else {
                    <Alert variant={AlertVariant::Info}>
                        "Return to the confirmed owned grade to save comp decisions."
                    </Alert>
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
        let e = Within::none(CompDecisionFormId);
        <form
            id={CompDecisionFormId}
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
            <Field id={e.id(f.decision)} label="Comp decision" hint="" error="">
                <select class={Select {}} {..e.control(f.decision)}>
                    <option value="accept" selected={!excluded}>"Include after review"</option>
                    <option value="exclude" selected={excluded}>"Exclude"</option>
                </select>
            </Field>
            <Field
                id={e.id(f.item_price)}
                label="Verified item price in USD (optional)"
                hint="Use only an item amount verified from the sale. Shipping and fees remain separate."
                error=""
            >
                <input
                    class={Input {}}
                    type="number"
                    value={price}
                    min="0.01"
                    step="0.01"
                    {..e.control(f.item_price).hint()}
                >
            </Field>
            <Field id={e.id(f.note)} label="Review reason" hint="" error="">
                <textarea
                    class={Textarea {}}
                    rows="3"
                    maxlength="1000"
                    required
                    {..e.control(f.note)}
                >
                    {saved.map_or("", |d| d.note.as_str())}
                </textarea>
            </Field>
            <p class={muted()}>
                "Including a comp does not override a conflicting card identity or unconfirmed sale outcome."
            </p>
            <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                "Save decision"
            </button>
        </form>
    }
}
