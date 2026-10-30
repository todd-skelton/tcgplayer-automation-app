use corten::prelude::*;

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{AssignInput, ConfirmInput, ImportInput, LookUpInput, OpenInput},
            identity::{Record, words},
            inventory::{InventoryPage, Listing},
            page::{Place, Screen},
            url::{self, Choice},
            views::{KeptChoice, RecommendationPanel, ResearchPanel, SellerPanels, SupplyPanel},
        },
    },
    layout::{Field, Notice, Tone},
    text::Msg,
    theme::*,
};

#[derive(Id)]
struct ProblemId(&'static str);

/// Why a post from `at` was refused, or an empty slot a refusal's patch fills.
#[component]
pub fn Problem<'a>(at: Place, why: Option<&'a str>) -> impl Patch {
    html! {
        <div id={ProblemId(at.name())} role="alert">
            if let Some(why) = why {
                <Notice tone={Tone::Warning}>{why}</Notice>
            }
        </div>
    }
}

/// The screen: look up a certificate, review the listing opened, confirm the certificate's
/// identity, and the seller's listings.
#[component(css)]
pub fn SlabScreen<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let f = LookUpInput::FIELDS;
    html! {
        <div class={SlabScreen}>
            <header>
                <h1>"Slab Pricing"</h1>
                <p class={muted()}>
                    "Review sold evidence and set a considered ask for your graded cards."
                </p>
            </header>
            <form
                method="post"
                action={url::LookUp { choice: choice.clone() }}
                data-patch
                class={(panel(), Line)}
            >
                <Field label="Grader" hint="">
                    <input
                        name={f.grader}
                        value={choice.grader.as_deref().unwrap_or("PSA")}
                        required
                        maxlength="40"
                    >
                </Field>
                <Field label="Certificate number" hint="">
                    <input
                        name={f.cert}
                        value={choice.cert.as_deref().unwrap_or("")}
                        required
                        maxlength="80"
                    >
                </Field>
                <button data-primary>"Look up certificate"</button>
            </form>
            <Problem at={Place::LookUp} why={screen.problem_at(Place::LookUp)} />
            if choice.listing.is_some() {
                <ReviewedListing screen={screen} />
            }
            match (choice.certificate(), &screen.record) {
                (Some(_), Some(record)) => {
                    <IdentityCard
                        record={record}
                        choice={choice}
                        problem={screen.problem_at(Place::Identity)}
                    />
                    if record.shown().is_some() {
                        <ResearchPanel screen={screen} record={record} t={t} />
                    }
                    if matches!(&screen.research, Some(Ok(_))) {
                        <SupplyPanel screen={screen} t={t} />
                        <RecommendationPanel screen={screen} record={record} t={t} />
                    }
                }
                (Some((grader, cert)), None) => {
                    <p class={panel()}>
                        {grader}" certificate "{cert}" has not been looked up yet."
                    </p>
                }
                (None, _) => {}
            }
            <InventoryPanel screen={screen} t={t} />
        </div>
    }
}

/// The listing opened for review: what it needs, and tying the confirmed identity to it.
#[component(css = SlabScreen)]
fn ReviewedListing<'a>(screen: &'a Screen) -> impl Render {
    let choice = &screen.choice;
    let separately = Choice {
        listing: None,
        ..choice.clone()
    };
    let f = AssignInput::FIELDS;
    html! {
        <section class={(panel(), Stack)} aria-label="Selected listing">
            match &screen.listing {
                None => <p>"The listing is not on this page of the inventory any more."</p>,
                Some(listing) => {
                    <p>"Selected listing: "{&listing.snapshot.title}</p>
                    <p class={muted()}>
                        if !listing.review_reasons.is_empty() {
                            {listing.review_reasons.iter().map(|r| words(r)).collect::<Vec<_>>().join("; ")}
                            ". "
                        }
                        "Look up and confirm a certificate to correct this listing's identity."
                    </p>
                    if let Some(record) = screen.record.as_ref().filter(|r| r.confirmed() && listing.identity_id.as_deref() != Some(r.id.as_str())) {
                        <form
                            method="post"
                            action={url::Assign { choice: choice.clone() }}
                            data-patch
                            class={Line}
                        >
                            <Field label="Listing identity correction reason" hint="">
                                <input name={f.note} required maxlength="1000">
                            </Field>
                            <button>"Assign confirmed identity"</button>
                            <small class={muted()}>
                                {&record.grader}" "{&record.certificate_number}
                            </small>
                        </form>
                    }
                }
            }
            <Problem at={Place::Listing} why={screen.problem_at(Place::Listing)} />
            <a href={url::SlabPricing::at(&separately)}>"Research certificate separately"</a>
        </section>
    }
}

/// A certificate's identity, what needs review, and the form that confirms or corrects it.
#[component(css = SlabScreen)]
fn IdentityCard<'a>(
    record: &'a Record,
    choice: &'a Choice,
    problem: Option<&'a str>,
) -> impl Render {
    let shown = record.shown();
    let card = shown.map(|s| s.card.clone()).unwrap_or_default();
    let grading = shown.map(|s| s.grading.clone()).unwrap_or_default();
    let f = ConfirmInput::FIELDS;
    let grades: Vec<f64> = (2..=20).map(|half| f64::from(half) / 2.0).collect();
    html! {
        <section class={(panel(), Stack)} aria-labelledby="slab-identity">
            <h2 id="slab-identity">
                {card.name.as_deref().unwrap_or("Card identity")}
                " · Owned "{&record.grader}" "
                {shown.map_or("grade unknown", |s| s.grading.encoding.as_str())}
            </h2>
            <p>
                "Certificate "{&record.certificate_number}" · "{words(&record.status)}
                " · Revision "{record.revision}
            </p>
            if shown.is_some() {
                <p>{card.summary()}</p>
            }
            if !record.review_reasons.is_empty() {
                <Notice tone={Tone::Warning}>
                    {record.review_reasons.iter().map(|r| words(r)).collect::<Vec<_>>().join("; ")}
                </Notice>
            }
            <details>
                <summary>"Confirm or correct identity"</summary>
                <form
                    method="post"
                    action={url::Confirm { choice: choice.clone() }}
                    data-patch
                    class={Stack}
                >
                    <p class={muted()}>
                        "Confirm the physical slab's card and grade. Blank fields remain unknown."
                    </p>
                    <input type="hidden" name={f.revision} value={record.revision}>
                    <div class={Line}>
                        <Field label="name" hint="">
                            <input
                                name={f.name}
                                value={card.name.as_deref().unwrap_or("")}
                                required
                                maxlength="200"
                            >
                        </Field>
                        for (label, name, value) in [("game", f.game, &card.game), ("language", f.language, &card.language), ("set", f.set, &card.set), ("card number", f.card_number, &card.card_number), ("year", f.year, &card.year), ("edition", f.edition, &card.edition), ("finish", f.finish, &card.finish), ("stamp", f.stamp, &card.stamp)] {
                            <Field label={label} hint="">
                                <input
                                    name={name}
                                    value={value.as_deref().unwrap_or("")}
                                    maxlength="200"
                                >
                            </Field>
                        }
                    </div>
                    <div class={Line}>
                        <Field label="Original grade encoding" hint="">
                            <input
                                name={f.encoding}
                                value={&grading.encoding}
                                required
                                maxlength="40"
                            >
                        </Field>
                        <Field label="Numeric grade" hint="">
                            <select name={f.number}>
                                <option value="" selected={grading.number.is_none()}>
                                    "Unmapped"
                                </option>
                                for n in &grades {
                                    <option value={n} selected={grading.number == Some(*n)}>
                                        {n}
                                    </option>
                                }
                            </select>
                        </Field>
                        for (label, name, value) in [("label", f.label, &grading.label), ("qualifier", f.qualifier, &grading.qualifier), ("autograph", f.autograph, &grading.autograph)] {
                            <Field label={label} hint="">
                                <input
                                    name={name}
                                    value={value.as_deref().unwrap_or("")}
                                    maxlength="40"
                                >
                            </Field>
                        }
                    </div>
                    <Field label="Reason for confirmation or correction" hint="">
                        <input name={f.note} required maxlength="1000">
                    </Field>
                    <button data-primary>"Confirm owned identity"</button>
                </form>
            </details>
            <Problem at={Place::Identity} why={problem} />
            <a href={slab_connections::url::SlabConnections}>"Data connections"</a>
        </section>
    }
}

/// The seller's saved eBay listings, a page at a time, and importing a CSV snapshot of them.
#[component(css = SlabScreen)]
fn InventoryPanel<'a>(screen: &'a Screen, t: Msg) -> impl Render {
    let choice = &screen.choice;
    let f = Choice::FIELDS;
    html! {
        <section class={(panel(), Stack)} aria-labelledby="slab-inventory">
            <h2 id="slab-inventory">"eBay inventory"</h2>
            <form method="get" action={url::SlabPricing::at(&Choice::default())} class={Line}>
                <KeptChoice choice={choice} except={&[f.seller, f.after, f.trail, f.listing]} />
                <Field label="Seller username" hint="">
                    <input
                        name={f.seller}
                        value={choice.seller.as_deref().unwrap_or("pokebash")}
                        required
                    >
                </Field>
                <button>"Open inventory"</button>
            </form>
            <Problem at={Place::Inventory} why={screen.problem_at(Place::Inventory)} />
            match &screen.inventory {
                None => {}
                Some(Err(why)) => <Notice tone={Tone::Warning}>{why}</Notice>,
                Some(Ok(page)) => {
                    <SellerPanels screen={screen} t={t} />
                    <Listings page={page} choice={choice} />
                }
            }
        </section>
    }
}

#[component(css = SlabScreen)]
fn Listings<'a>(page: &'a InventoryPage, choice: &'a Choice) -> impl Render {
    let seller = choice.seller.as_deref().unwrap_or("");
    let (fi, fo) = (ImportInput::FIELDS, OpenInput::FIELDS);
    html! {
        <p class={muted()}>
            {seller}" · Saved inventory · Page "{choice.trail.len() + 1}
            ". Open a slab to review or assign its certificate."
        </p>
        <details>
            <summary>"Import CSV"</summary>
            <form
                method="post"
                action={url::Import { choice: choice.clone() }}
                data-patch
                class={Stack}
            >
                <p class={muted()}>
                    "Import a partial inventory snapshot for "{seller}
                    ". Required columns: item_id, title, price, currency, quantity, state, format. Add grader and certificate_number for certificate lookup. Existing rows are matched by item_id and variation_key."
                </p>
                <input type="hidden" name={fi.revision} value={page.revision}>
                <Field label="Inventory CSV" hint="Paste the CSV, up to 2 MiB.">
                    <textarea name={fi.csv} rows="6" required maxlength="2097152"></textarea>
                </Field>
                <button>"Import into "{seller}</button>
            </form>
        </details>
        <div class={Scroll}>
            <table class={Table} aria-label="Saved eBay listings">
                <thead>
                    <tr>
                        <th>"Review"</th>
                        <th>"Listing"</th>
                        <th>"Current ask"</th>
                        <th>"Owned grade"</th>
                        <th>"State"</th>
                        <th>"Needs attention"</th>
                    </tr>
                </thead>
                <tbody>
                    if page.items.is_empty() {
                        <tr><td colspan="6">"No listings are saved for this seller."</td></tr>
                    }
                    for listing in &page.items {
                        <tr
                            key={&listing.id}
                            aria-current={(choice.listing.as_deref() == Some(listing.id.as_str())).then_some("true")}
                        >
                            <td>
                                <form
                                    method="post"
                                    action={url::Open { choice: choice.clone() }}
                                    data-patch
                                >
                                    <input type="hidden" name={fo.id} value={&listing.id}>
                                    <button>"Open slab"</button>
                                </form>
                            </td>
                            <td>
                                <a href={&listing.url} target="_blank" rel="noreferrer">
                                    {&listing.snapshot.title}
                                </a>
                            </td>
                            <td>{ask(listing)}</td>
                            <td>{listing.owned_grade()}</td>
                            <td>{&listing.state}</td>
                            <td>
                                {listing.review_reasons.iter().map(|r| words(r)).collect::<Vec<_>>().join("; ")}
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
        <nav class={Line} aria-label="Inventory pages">
            match choice.previous_page() {
                Some(previous) => <a href={url::SlabPricing::at(&previous)}>"Previous page"</a>,
                None => <span class={muted()}>"Previous page"</span>,
            }
            match &page.next {
                Some(next) => <a href={url::SlabPricing::at(&choice.next_page(next))}>"Next page"</a>,
                None => <span class={muted()}>"Next page"</span>,
            }
        </nav>
    }
}

/// `USD 420.50`, as the React grid wrote an ask.
fn ask(listing: &Listing) -> String {
    format!(
        "{} {:.2}",
        listing.snapshot.price.currency, listing.snapshot.price.amount
    )
}
