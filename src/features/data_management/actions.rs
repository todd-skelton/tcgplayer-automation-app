//! The screen and its jobs. A job's answer is its card drawn again with what it did (the page,
//! without JavaScript), sent with the job's status.
use corten::{Mode, Refusal, prelude::*};

use super::{
    catalog::{
        maintenance::{self, Request},
        source::TcgPlayerCatalog,
    },
    jobs::{self, Job, Line, LineInput, ProductInput, Ran, SetInput},
    views::{DataScreen, JobCard},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    tcgplayer::TcgPlayer,
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
    async fn read(req: &Req, db: &Database) -> corten::Result<Screen> {
        let lines = jobs::lines(db).await?;
        Ok(Screen {
            new_products: LineInput::first(&lines),
            every_product: LineInput::first(&lines),
            product: ProductInput::first(&lines),
            set: SetInput::first(&lines),
            chrome: Chrome::read(req, db).await,
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
    let screen = Screen::read(&req, &db).await?;
    page(&req, &screen)
}

fn page(req: &Req, screen: &Screen) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="Data Management" chrome={screen.chrome} head="">
            <DataScreen screen={screen} />
        </Layout>
    })
}

/// Runs `job` as its form asks, or answers what the form is missing.
async fn run(
    req: &Req,
    db: &Database,
    mut screen: Screen,
    job: Job,
    request: Result<Request, Errors>,
) -> HtmlResult {
    screen.posted = Some(job);
    let request = match request {
        Ok(request) => request,
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
    let mut conn = db.0.acquire().await?;
    // A job may hold a session lock (a product line's sync); a request cut off mid-job closes the
    // connection, ending the lock with it, instead of pooling it locked.
    conn.close_on_drop();
    let catalog = TcgPlayerCatalog(TcgPlayer::new(db.clone()));
    let answer = maintenance::run(&mut conn, &catalog, &request).await;
    match answer.outcome {
        Ok(message) => {
            screen.ran = Some(Ran::Done(message));
            if req.mode == Mode::Action {
                return req.patch(JobCard {
                    screen: &screen,
                    job,
                });
            }
            page(req, &screen)
        }
        Err(message) => {
            // A job TCGplayer or the database failed is a 502; one refused, the input's.
            let refusal = if answer.status >= 500 {
                Refusal::Upstream
            } else {
                Refusal::Invalid
            };
            let mut errors = Errors::new();
            errors.refuse(refusal, &message);
            screen.ran = Some(Ran::Failed(message));
            let card = JobCard {
                screen: &screen,
                job,
            };
            req.invalid(&errors, card, || async { page(req, &screen) })
                .await
        }
    }
}

pub async fn refresh_product_lines(req: Req, State(db): State<Database>) -> HtmlResult {
    let screen = Screen::read(&req, &db).await?;
    run(
        &req,
        &db,
        screen,
        Job::ProductLines,
        Ok(Request::ProductLines),
    )
    .await
}

pub async fn sync_new_products(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&req, &db).await?;
    let request = input
        .read(&screen.lines)
        .map(|line| Request::NewProducts { line });
    screen.new_products = input;
    run(&req, &db, screen, Job::NewProducts, request).await
}

pub async fn check_product_line(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&req, &db).await?;
    let request = input
        .read(&screen.lines)
        .map(|line| Request::EveryProduct { line });
    screen.every_product = input;
    run(&req, &db, screen, Job::EveryProduct, request).await
}

pub async fn repair_product(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<ProductInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&req, &db).await?;
    let request = input
        .read(&screen.lines)
        .map(|(line, product)| Request::Product { line, product });
    screen.product = input;
    run(&req, &db, screen, Job::Product, request).await
}

pub async fn hydrate_set(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SetInput>,
) -> HtmlResult {
    let mut screen = Screen::read(&req, &db).await?;
    let delete_existing = input.delete_existing;
    let request = input.read(&screen.lines).map(|(set, line)| Request::Set {
        set,
        line,
        delete_existing,
    });
    screen.set = input;
    run(&req, &db, screen, Job::Set, request).await
}
