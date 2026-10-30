//! The screen and its jobs. A job's answer is its card drawn again with what it did (the page,
//! without JavaScript), sent with the job's status.
use corten::{Mode, axum::http::StatusCode, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    jobs::{self, Job, Line, LineInput, ProductInput, Ran, SetInput},
    views::{DataScreen, JobCard},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
};

/// Everything the page shows: the product lines, each form as it was last filled in, and the
/// job just run, if any, with what it came to or what its form is missing.
pub struct Screen {
    pub lines: Vec<Line>,
    pub chrome: Chrome,
    pub new_products: LineInput,
    pub every_product: LineInput,
    pub product: ProductInput,
    pub set: SetInput,
    pub posted: Option<Job>,
    pub ran: Option<Ran>,
    pub errors: Errors,
}

impl Screen {
    async fn read(db: &Database) -> corten::Result<Screen> {
        let lines = jobs::lines(db).await?;
        Ok(Screen {
            new_products: LineInput::first(&lines),
            every_product: LineInput::first(&lines),
            product: ProductInput::first(&lines),
            set: SetInput::first(&lines),
            chrome: Chrome::read(db).await,
            lines,
            posted: None,
            ran: None,
            errors: Errors::new(),
        })
    }

    /// What `job` came to, or `errors` when its form is not filled in.
    pub fn of(&self, job: Job) -> (Option<&Ran>, &Errors) {
        static NONE: std::sync::LazyLock<Errors> = std::sync::LazyLock::new(Errors::new);
        if self.posted == Some(job) {
            (self.ran.as_ref(), &self.errors)
        } else {
            (None, &NONE)
        }
    }
}

pub async fn show(req: Req, State(db): State<Database>) -> HtmlResult {
    let screen = Screen::read(&db).await?;
    page(&req, &screen)
}

fn page(req: &Req, screen: &Screen) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="Data Management" chrome={screen.chrome} head="">
            <DataScreen screen={screen} />
        </Layout>
    })
}

/// Runs `job` with `fields` on the Node app, or answers what its form is missing.
async fn run(
    req: &Req,
    legacy: &Legacy,
    mut screen: Screen,
    job: Job,
    fields: Result<Value, Errors>,
) -> HtmlResult {
    screen.posted = Some(job);
    let fields = match fields {
        Ok(fields) => fields,
        Err(errors) => {
            screen.errors = errors;
            let card = JobCard {
                screen: &screen,
                job,
            };
            return req
                .invalid(&screen.errors, card, || async { page(req, &screen) })
                .await;
        }
    };
    #[derive(Deserialize)]
    struct Did {
        message: String,
    }
    let status = match legacy
        .send_for_status::<_, Did>("/api/data-management", &jobs::ask(job, fields))
        .await
    {
        Ok(did) => {
            screen.ran = Some(Ran::Done(did.message));
            StatusCode::OK
        }
        Err(refusal) => {
            screen.ran = Some(Ran::Failed(refusal.message));
            if refusal.status.is_server_error() {
                StatusCode::BAD_GATEWAY
            } else {
                refusal.status
            }
        }
    };
    if req.mode == Mode::Action {
        let card = JobCard {
            screen: &screen,
            job,
        };
        return req.patch_with_status(status, card);
    }
    let mut answer = page(req, &screen)?;
    *answer.status_mut() = status;
    Ok(answer)
}

pub async fn refresh_product_lines(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
) -> HtmlResult {
    let screen = Screen::read(&db).await?;
    run(&req, &legacy, screen, Job::ProductLines, Ok(Value::Null)).await
}

pub async fn sync_new_products(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&db).await?;
    let fields = input
        .read(&screen.lines)
        .map(|line| json!({ "categoryId": line.to_string() }));
    screen.new_products = input;
    run(&req, &legacy, screen, Job::NewProducts, fields).await
}

pub async fn check_product_line(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&db).await?;
    let fields = input
        .read(&screen.lines)
        .map(|line| json!({ "categoryId": line.to_string() }));
    screen.every_product = input;
    run(&req, &legacy, screen, Job::EveryProduct, fields).await
}

pub async fn repair_product(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Form(input): Form<ProductInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&db).await?;
    let fields = input.read(&screen.lines).map(|(line, product)| {
        json!({ "productId": product.to_string(), "productLineId": line.to_string() })
    });
    screen.product = input;
    run(&req, &legacy, screen, Job::Product, fields).await
}

pub async fn hydrate_set(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Form(input): Form<SetInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&db).await?;
    let delete = input.delete_existing;
    let fields = input.read(&screen.lines).map(|(set, line)| {
        let mut fields = json!({ "setName": set, "productLineName": line });
        if delete {
            fields["deleteExistingSet"] = json!("on");
        }
        fields
    });
    screen.set = input;
    run(&req, &legacy, screen, Job::Set, fields).await
}
