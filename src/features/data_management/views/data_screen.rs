use corten::{form::Within, prelude::*};

use crate::{
    features::{
        data_management::{
            actions::Screen,
            jobs::{Job, Line, LineInput, ProductInput, Ran, SetInput},
            url,
        },
        http_configuration,
    },
    layout::Notice,
    theme::*,
    ui::{
        alert::AlertVariant,
        button::{Button, ButtonSize, ButtonVariant},
        card::{CardCompact, CardPanel},
        checkbox::Checkbox,
        field::Field,
        input::Input,
        select::Select,
    },
};

#[derive(Id)]
struct ProductLinesCardId;
#[derive(Id)]
struct NewProductsCardId;
#[derive(Id)]
struct EveryProductCardId;
#[derive(Id)]
struct RepairProductCardId;
#[derive(Id)]
struct HydrateSetCardId;

#[component(css)]
pub fn DataScreen<'a>(screen: &'a Screen) -> impl Render {
    html! {
        <section class={(Stack, DataScreen)}>
            <header>
                <h1>"Data Management"</h1>
                <p class={muted()}>
                    "Refresh the local TCGPlayer catalog: product lines, sets, products, and SKUs. Use the smallest job that fixes the problem."
                </p>
            </header>
            if screen.chrome.auth_cookie_missing {
                <Notice variant={AlertVariant::Warning}>
                    "Live TCGPlayer requests are blocked until the HTTP configuration page has a valid authentication cookie. "
                    <a href={http_configuration::url::HttpSettings}>"Fix Auth"</a>
                </Notice>
            }
            <div class={Cards}>
                for job in [Job::ProductLines, Job::NewProducts, Job::EveryProduct, Job::Product, Job::Set] {
                    <JobCard screen={screen} job={job} />
                }
            </div>
        </section>
    }
}

/// One job's card: what it does, its form, and what it last came to.
#[component(css = DataScreen)]
pub fn JobCard<'a>(screen: &'a Screen, job: Job) -> impl Patch {
    let (ran, errors) = screen.of(job);
    let lines = screen.lines.as_slice();
    html! {
        match job {
            Job::ProductLines => {
                let e = errors.within(ProductLinesCardId);
                <section
                    id={ProductLinesCardId}
                    class={(CardPanel {}, CardCompact {}, Stack)}
                    aria-labelledby="job-product-lines"
                >
                    <h2 id="job-product-lines">"Refresh product lines"</h2>
                    <p class={muted()}>
                        "Pull the current list of TCGPlayer product lines and category filters before deeper maintenance."
                    </p>
                    <form
                        method="post"
                        action={url::RefreshProductLines}
                        data-patch
                        class={(Stack, JobForm)}
                    >
                        <p class={muted()}>
                            "Run this when you notice new product lines, missing category filters, or a stale list in the database."
                        </p>
                        <Run ready="Refresh Product Lines" working="Refreshing Product Lines..." />
                        <Outcome ran={ran} idle="No refresh has been run in this session yet." />
                    </form>
                </section>
            }
            Job::NewProducts => {
                let e = errors.within(NewProductsCardId);
                <section
                    id={NewProductsCardId}
                    class={(CardPanel {}, CardCompact {}, Stack)}
                    aria-labelledby="job-new-products"
                >
                    <h2 id="job-new-products">"Sync new products"</h2>
                    <p class={muted()}>
                        "Compare every set's product count with TCGplayer, then fetch only the sets that changed and only their missing products and SKUs."
                    </p>
                    <form
                        method="post"
                        action={url::SyncNewProducts}
                        data-patch
                        class={(Stack, JobForm)}
                    >
                        {line_choice(LineInput::FIELDS.product_line, lines, screen.new_products.product_line, &e)}
                        <p class={muted()}>
                            "Use this after new sets release or when promo sets grow. New SKUs on products you already have are not detected; use Repair one product for those."
                        </p>
                        <Run ready="Sync New Products" working="Syncing New Products..." />
                        <Outcome
                            ran={ran}
                            idle="Unchanged sets are skipped after two quick TCGplayer requests: the set list and the per-set counts."
                        />
                    </form>
                </section>
            }
            Job::EveryProduct => {
                let e = errors.within(EveryProductCardId);
                <section
                    id={EveryProductCardId}
                    class={(CardPanel {}, CardCompact {}, Stack)}
                    aria-labelledby="job-every-product"
                >
                    <h2 id="job-every-product">"Check every product in a product line"</h2>
                    <p class={muted()}>
                        "Walk every stored product in a category, fetching sets with no products and products with no SKUs. Slow on large product lines."
                    </p>
                    <form
                        method="post"
                        action={url::CheckProductLine}
                        data-patch
                        class={(Stack, JobForm)}
                    >
                        {line_choice(LineInput::FIELDS.product_line, lines, screen.every_product.product_line, &e)}
                        <Run ready="Check Every Product" working="Checking Every Product..." />
                        <Outcome
                            ran={ran}
                            idle="Use Sync new products first; this full pass is the fallback when a whole category needs reconciliation."
                        />
                    </form>
                </section>
            }
            Job::Product => {
                let e = errors.within(RepairProductCardId);
                <section
                    id={RepairProductCardId}
                    class={(CardPanel {}, CardCompact {}, Stack)}
                    aria-labelledby="job-product"
                >
                    <h2 id="job-product">"Repair one product"</h2>
                    <p class={muted()}>
                        "Refetch a single product and its SKUs when one listing is wrong, missing, or tied to the wrong set."
                    </p>
                    <form
                        method="post"
                        action={url::RepairProduct}
                        data-patch
                        class={(Stack, JobForm)}
                    >
                        {line_choice(ProductInput::FIELDS.product_line, lines, screen.product.product_line, &e)}
                        <Field
                            id={e.id(ProductInput::FIELDS.product)}
                            label="Product ID"
                            hint=""
                            error={e.message(ProductInput::FIELDS.product)}
                        >
                            <input
                                class={Input {}}
                                type="number"
                                min="1"
                                required
                                value={screen.product.product}
                                placeholder="Enter the exact TCGPlayer product ID"
                                {..e.control(ProductInput::FIELDS.product)}
                            >
                        </Field>
                        <Run ready="Repair Product and SKUs" working="Repairing Product..." />
                        <Outcome
                            ran={ran}
                            idle="Best for isolated catalog drift without paying the cost of a broader sync."
                        />
                    </form>
                </section>
            }
            Job::Set => {
                let e = errors.within(HydrateSetCardId);
                <section
                    id={HydrateSetCardId}
                    class={(CardPanel {}, CardCompact {}, Stack)}
                    aria-labelledby="job-set"
                >
                    <h2 id="job-set">"Hydrate one set"</h2>
                    <p class={muted()}>
                        "Fetch set products and SKUs directly from TCGPlayer, even if the set is not fully represented locally yet."
                    </p>
                    <form
                        method="post"
                        action={url::HydrateSet}
                        data-patch
                        class={(Stack, JobForm)}
                    >
                        <Field
                            id={e.id(SetInput::FIELDS.set_name)}
                            label="Set name"
                            hint=""
                            error={e.message(SetInput::FIELDS.set_name)}
                        >
                            <input
                                class={Input {}}
                                required
                                value={&screen.set.set_name}
                                placeholder="Example: Duskmourn: House of Horror"
                                {..e.control(SetInput::FIELDS.set_name)}
                            >
                        </Field>
                        <Field
                            id={e.id(SetInput::FIELDS.product_line)}
                            label="Product line"
                            hint=""
                            error={e.message(SetInput::FIELDS.product_line)}
                        >
                            <select
                                class={Select {}}
                                required
                                {..e.control(SetInput::FIELDS.product_line)}
                            >
                                for line in lines {
                                    <option
                                        value={&line.url_name}
                                        selected={line.url_name == screen.set.product_line}
                                    >
                                        {&line.name}
                                    </option>
                                }
                            </select>
                        </Field>
                        <Checkbox label="Delete existing set data first and fully refetch it">
                            <input
                                type="checkbox"
                                name={SetInput::FIELDS.delete_existing}
                                checked={screen.set.delete_existing}
                            >
                        </Checkbox>
                        <Run ready="Hydrate Set Products and SKUs" working="Hydrating Set..." />
                        <Outcome
                            ran={ran}
                            idle="Use the full refetch checkbox when an existing set needs to be cleared and rebuilt cleanly."
                        />
                    </form>
                </section>
            }
        }
    }
}

/// The product lines to choose from, by id.
fn line_choice<'a, I: Id>(
    name: FieldName<i32>,
    lines: &'a [Line],
    chosen: Option<i32>,
    e: &'a Within<'a, I>,
) -> impl Render + 'a {
    html! {
        <Field id={e.id(name)} label="Product line" hint="" error={e.message(name)}>
            <select class={Select {}} required {..e.control(name)}>
                for line in lines {
                    <option value={line.id} selected={chosen == Some(line.id)}>
                        {&line.name}
                    </option>
                }
            </select>
        </Field>
    }
}

/// The form's button, which says it is working while the job runs (`aria-busy` on the form).
#[component(css = DataScreen)]
fn Run<'a>(ready: &'a str, working: &'a str) -> impl Render {
    html! {
        <div>
            <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                <span class={Ready}>{ready}</span>
                <span class={Working}>{working}</span>
            </button>
        </div>
    }
}

/// What the job last came to, kept under its form; while it runs, that it is running.
#[component(css = DataScreen)]
fn Outcome<'a>(ran: Option<&'a Ran>, idle: &'a str) -> impl Render {
    html! {
        <div>
            <p class={(Waiting, Said)} role="status">
                "Request in progress. This panel will keep the result attached to this job."
            </p>
            match ran {
                Some(Ran::Done(message)) => {
                    <div class={(Said, Complete, Shown)} role="status">
                        <strong>"Job complete"</strong>
                        <p>{message}</p>
                    </div>
                }
                Some(Ran::Failed(message)) => {
                    <div class={(Said, Failed, Shown)} role="alert">
                        <strong>"Job failed"</strong>
                        <p>{message}</p>
                    </div>
                }
                None => <p class={(Said, Idle, Shown, muted())}>{idle}</p>,
            }
        </div>
    }
}
