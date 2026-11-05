use corten::{form::keep_query, prelude::*};
use corten_ui::rows;

use crate::{
    features::{
        slab_connections,
        slab_pricing::{
            actions::{AssignInput, ConfirmInput, ImportInput, LookUpInput, OpenInput},
            identity::{Record, words},
            inventory::{InventoryPage, Listing, ListingColumn},
            page::{Place, Screen},
            url::{self, Choice},
            views::{CompReview, RecommendationPanel, ResearchPanel, SellerPanels, SupplyPanel},
        },
    },
    layout::Notice,
    row_order,
    text::Msg,
    theme::*,
    ui::{
        alert::AlertVariant,
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        field::Field,
        input::Input,
        select::Select,
        table::{Sort, SortHeader, Table, TableLayout},
        textarea::Textarea,
        visually_hidden::VisuallyHidden,
    },
};

#[derive(Id)]
struct ProblemId(&'static str);

// The slab forms' answers carry no field errors: a refusal is the place's Problem. Their fields
// are named from the form's id through Within::none.
#[derive(Id)]
struct LookUpFormId;
#[derive(Id)]
struct AssignFormId;
#[derive(Id)]
struct ConfirmFormId;
#[derive(Id)]
struct InventoryFormId;
#[derive(Id)]
struct ImportFormId;

/// Why a post from `at` was refused, or an empty slot a refusal's patch fills.
#[component]
pub fn Problem<'a>(at: Place, why: Option<&'a str>) -> impl Patch {
    html! {
        <div id={ProblemId(at.name())}>
            if let Some(why) = why {
                <Notice variant={AlertVariant::Warning}>{why}</Notice>
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
            let e = Within::none(LookUpFormId);
            <form
                id={LookUpFormId}
                method="post"
                action={url::LookUp { choice: choice.clone() }}
                data-patch
                class={(CardPanel {}, CardCompact {}, Line)}
            >
                <Field id={e.id(f.grader)} label="Grader" hint="" error="">
                    <input
                        class={Input {}}
                        value={choice.grader.as_deref().unwrap_or("PSA")}
                        required
                        maxlength="40"
                        {..e.control(f.grader)}
                    >
                </Field>
                <Field id={e.id(f.cert)} label="Certificate number" hint="" error="">
                    <input
                        class={Input {}}
                        value={choice.cert.as_deref().unwrap_or("")}
                        required
                        maxlength="80"
                        {..e.control(f.cert)}
                    >
                </Field>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Look up certificate"
                </button>
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
                        if choice.comps.is_some() {
                            <CompReview screen={screen} />
                        }
                    }
                }
                (Some((grader, cert)), None) => {
                    <p class={(CardPanel {}, CardCompact {})}>
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
        <section class={(CardPanel {}, CardCompact {}, Stack)} aria-label="Selected listing">
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
                        let e = Within::none(AssignFormId);
                        <form
                            id={AssignFormId}
                            method="post"
                            action={url::Assign { choice: choice.clone() }}
                            data-patch
                            class={Line}
                        >
                            <Field
                                id={e.id(f.note)}
                                label="Listing identity correction reason"
                                hint=""
                                error=""
                            >
                                <input
                                    class={Input {}}
                                    required
                                    maxlength="1000"
                                    {..e.control(f.note)}
                                >
                            </Field>
                            <button
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                            >
                                "Assign confirmed identity"
                            </button>
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
        <section class={(CardPanel {}, CardCompact {}, Stack)} aria-labelledby="slab-identity">
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
                <Notice variant={AlertVariant::Warning}>
                    {record.review_reasons.iter().map(|r| words(r)).collect::<Vec<_>>().join("; ")}
                </Notice>
            }
            <details>
                <summary>"Confirm or correct identity"</summary>
                let e = Within::none(ConfirmFormId);
                <form
                    id={ConfirmFormId}
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
                        <Field id={e.id(f.name)} label="name" hint="" error="">
                            <input
                                class={Input {}}
                                value={card.name.as_deref().unwrap_or("")}
                                required
                                maxlength="200"
                                {..e.control(f.name)}
                            >
                        </Field>
                        for (label, name, value) in [("game", f.game, &card.game), ("language", f.language, &card.language), ("set", f.set, &card.set), ("card number", f.card_number, &card.card_number), ("year", f.year, &card.year), ("edition", f.edition, &card.edition), ("finish", f.finish, &card.finish), ("stamp", f.stamp, &card.stamp)] {
                            <Field id={e.id(name)} label={label} hint="" error="">
                                <input
                                    class={Input {}}
                                    value={value.as_deref().unwrap_or("")}
                                    maxlength="200"
                                    {..e.control(name)}
                                >
                            </Field>
                        }
                    </div>
                    <div class={Line}>
                        <Field
                            id={e.id(f.encoding)}
                            label="Original grade encoding"
                            hint=""
                            error=""
                        >
                            <input
                                class={Input {}}
                                value={&grading.encoding}
                                required
                                maxlength="40"
                                {..e.control(f.encoding)}
                            >
                        </Field>
                        <Field id={e.id(f.number)} label="Numeric grade" hint="" error="">
                            <select class={Select {}} {..e.control(f.number)}>
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
                            <Field id={e.id(name)} label={label} hint="" error="">
                                <input
                                    class={Input {}}
                                    value={value.as_deref().unwrap_or("")}
                                    maxlength="40"
                                    {..e.control(name)}
                                >
                            </Field>
                        }
                    </div>
                    <Field
                        id={e.id(f.note)}
                        label="Reason for confirmation or correction"
                        hint=""
                        error=""
                    >
                        <input class={Input {}} required maxlength="1000" {..e.control(f.note)}>
                    </Field>
                    <button
                        class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                    >
                        "Confirm owned identity"
                    </button>
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
        <section class={(CardPanel {}, CardCompact {}, Stack)} aria-labelledby="slab-inventory">
            <h2 id="slab-inventory">"eBay inventory"</h2>
            let e = Within::none(InventoryFormId);
            <form
                id={InventoryFormId}
                method="get"
                action={url::SlabPricing::at(&Choice::default())}
                class={Line}
            >
                // Another seller's inventory opens at its first page, no listing open.
                {keep_query(
                    &url::SlabPricing::at(&Choice {
                        after: None,
                        trail: Vec::new(),
                        listing: None,
                        ..choice.clone()
                    }),
                    html! {
                    <Field id={e.id(f.seller)} label="Seller username" hint="" error="">
                        <input class={Input {}}
                            value={choice.seller.as_deref().unwrap_or("pokebash")}
                            required
                            {..e.control(f.seller)}
                        >
                    </Field>
                    <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>"Open inventory"</button>
                    },
                )}
            </form>
            <Problem at={Place::Inventory} why={screen.problem_at(Place::Inventory)} />
            match &screen.inventory {
                None => {}
                Some(Err(why)) => <Notice variant={AlertVariant::Warning}>{why}</Notice>,
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
    // The page's own listings in the order asked for, as `rows::sort` orders them with the
    // script; a sort link keeps the page.
    let down = choice.listings_down == Some(true);
    let mut listed: Vec<&Listing> = page.items.iter().collect();
    if let Some(by) = choice.listings_by {
        row_order::sort(&mut listed, down, |listing| by.key(listing));
    }
    let sorted = move |column: ListingColumn| {
        let at = |descending: bool| {
            url::SlabPricing::at(&Choice {
                listings_by: Some(column),
                listings_down: descending.then_some(true),
                ..choice.clone()
            })
        };
        let sort = row_order::header(choice.listings_by.as_ref(), down, &column);
        (sort, at(false), at(true))
    };
    html! {
        <p class={muted()}>
            {seller}" · Saved inventory · Page "{choice.trail.len() + 1}
            ". Open a slab to review or assign its certificate."
        </p>
        <details>
            <summary>"Import CSV"</summary>
            let e = Within::none(ImportFormId);
            <form
                id={ImportFormId}
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
                <Field
                    id={e.id(fi.csv)}
                    label="Inventory CSV"
                    hint="Paste the CSV, up to 2 MiB."
                    error=""
                >
                    <textarea
                        class={Textarea {}}
                        rows="6"
                        required
                        maxlength="2097152"
                        {..e.control(fi.csv).hint()}
                    ></textarea>
                </Field>
                <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}>
                    "Import into "{seller}
                </button>
            </form>
        </details>
        <Table layout={TableLayout::Scroll}>
            <table class={Cells}>
                <caption class={VisuallyHidden {}}>
                    "Saved eBay listings. Sorting orders the listings on this page."
                </caption>
                // A hover does not fetch the sorted page, which a click with the script does not
                // use.
                <thead data-no-prefetch>
                    <tr>
                        <th scope="col">"Review"</th>
                        for (column, label) in ListingColumn::ALL {
                            let (sort, ascending, descending) = sorted(column);
                            <SortHeader
                                label={label}
                                sort={sort}
                                ascending={&ascending}
                                descending={&descending}
                                first={Sort::Ascending}
                                class={()}
                                on:sort={rows::sort(event, target)}
                            />
                        }
                    </tr>
                </thead>
                <tbody>
                    if page.items.is_empty() {
                        <tr><td colspan="6">"No listings are saved for this seller."</td></tr>
                    }
                    for listing in listed {
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
                                    <button
                                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                                    >
                                        "Open slab"
                                    </button>
                                </form>
                            </td>
                            <td>
                                <a href={&listing.url} target="_blank" rel="noreferrer">
                                    {&listing.snapshot.title}
                                </a>
                            </td>
                            <td data-sort={listing.snapshot.price.amount}>{ask(listing)}</td>
                            <td>{listing.owned_grade()}</td>
                            <td>{&listing.state}</td>
                            <td>{listing.attention()}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </Table>
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
