use std::collections::{HashMap, HashSet};

use corten::{Mode, Refusal, axum::http::StatusCode, prelude::*};
use serde::Deserialize;

use super::{
    catalog::{self, Condition, Product, ProductLine, Scope, Set, Shown},
    pending::{self, Place, Totals},
    queue::{self, CostRate, Queue, QueueInput},
    url::{self, Selection},
    views::{
        BATCHES_EVERY, BackgroundBatches, ClearConfirm, CountForm, Counted, IntakeError,
        IntakeScreen, QueueForm, QueueNotice, QueueTotals, Queuing, label, redrawn,
    },
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
};

/// Everything the screen draws for a selection.
pub struct Screen {
    pub selection: Selection,
    pub lines: Vec<ProductLine>,
    pub line: i32,
    pub sets: Vec<Set>,
    pub set: Option<i32>,
    pub scope: Scope,
    pub condition: Condition,
    pub products: Vec<Product>,
    pub quantities: HashMap<i32, i32>,
    pub totals: Totals,
}

impl Screen {
    pub async fn read(db: &Database, selection: &Selection) -> sqlx::Result<Screen> {
        let line = selection.line.unwrap_or(catalog::DEFAULT_PRODUCT_LINE);
        let (lines, sets, quantities) = tokio::try_join!(
            catalog::product_lines(db),
            catalog::sets(db, line),
            pending::quantities(db)
        )?;
        let set = selection
            .set
            .filter(|id| sets.iter().any(|s| s.id == *id))
            .or_else(|| sets.first().map(|s| s.id));
        let scope = selection.scope.unwrap_or_default();
        let search = selection.search.as_deref().unwrap_or("").trim();
        let skus = match (scope, set) {
            (Scope::AllSets, _) => catalog::card_number_skus(db, line, search).await?,
            (Scope::Set, Some(set)) => catalog::set_skus(db, line, set).await?,
            (Scope::Set, None) => Vec::new(),
        };
        let shown = Shown {
            product_type: selection.product_type.unwrap_or_default(),
            languages: &selection.language,
        };
        let products = catalog::products(skus, &shown);
        let products = match scope {
            Scope::Set => catalog::search(products, search),
            Scope::AllSets => products,
        };
        Ok(Screen {
            selection: selection.clone(),
            lines,
            line,
            sets,
            set,
            scope,
            condition: selection.condition.unwrap_or_default(),
            products,
            totals: Totals::of(&quantities),
            quantities,
        })
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::InventoryManager>,
) -> HtmlResult {
    let notice = at
        .queued
        .map(|batch| format!("Batch {batch} queued. You can keep adding inventory."));
    let drawn = Drawn {
        notice: notice.as_deref(),
        ..Drawn::default()
    };
    page(&req, &db, &legacy, &at.selection, &drawn).await
}

/// What a page is drawn with besides the stored state: a refused change, the queue form as sent,
/// its errors, and what the last queue did.
#[derive(Default)]
struct Drawn<'a> {
    error: Option<&'a str>,
    input: Option<&'a QueueInput>,
    errors: Option<&'a Errors>,
    notice: Option<&'a str>,
}

/// The whole screen for `selection`.
async fn page(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    selection: &Selection,
    drawn: &Drawn<'_>,
) -> HtmlResult {
    let (screen, batches, chrome) = tokio::join!(
        Screen::read(db, selection),
        queue::batches(legacy),
        Chrome::read(db)
    );
    let screen = screen?;
    let (fresh, none) = (QueueInput::new(), Errors::new());
    let queuing = Queuing {
        batches: batches.as_ref().map_err(String::as_str),
        input: drawn.input.unwrap_or(&fresh),
        errors: drawn.errors.unwrap_or(&none),
        notice: drawn.notice,
    };
    req.page(html! {
        <Layout req={req} title="Inventory Manager" chrome={chrome} head="">
            <IntakeScreen screen={&screen} error={drawn.error} queuing={&queuing} />
        </Layout>
    })
}

/// A SKU's count as its form sends it: the count, the count the server last answered (so a count
/// changed meanwhile is refused), and the key the change is applied once by.
#[derive(Clone, Debug, Deserialize, Fields)]
pub struct CountInput {
    pub quantity: u32,
    pub seen: u32,
    pub submit: SubmitKey,
}

/// The SKU's form with the count stored, the totals, and what went wrong, if anything. Without
/// JavaScript, the screen again.
pub async fn count(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::Count>,
    Form(input): Form<CountInput>,
) -> HtmlResult {
    let (product, condition) = catalog::counted(&db, at.sku)
        .await?
        .ok_or_else(corten::Error::not_found)?;
    let place = Place {
        product_line_id: product.product_line_id,
        set_id: product.set_id,
        product_id: product.product_id,
    };
    let applied = pending::set(
        &legacy,
        input.submit.as_str(),
        at.sku,
        place,
        input.quantity,
        input.seen,
    )
    .await;
    if req.mode != Mode::Action {
        return req.redirect(&url::InventoryManager {
            selection: at.selection,
            queued: None,
        });
    }
    let quantities = pending::quantities(&db).await?;
    let stored = quantities.get(&at.sku).copied().unwrap_or(0);
    let totals = Totals::of(&quantities);
    let label = label(&product, condition);
    let counted = Counted {
        sku: at.sku,
        label: &label,
    };
    let field = html! {
        <CountForm counted={&counted} quantity={stored} selection={&at.selection} />
        <QueueTotals totals={totals} counted={&queue::fingerprint(&quantities)} />
        <ClearConfirm selection={&at.selection} totals={totals} />
    };
    match applied {
        Ok(_) => req.patch(html! {
            {field}
            <IntakeError message={None} />
        }),
        Err(message) => req.patch_with_status(
            StatusCode::CONFLICT,
            html! {
                {field}
                <IntakeError message={Some(&message)} />
            },
        ),
    }
}

#[derive(Deserialize, Fields)]
pub struct ClearInput {
    pub submit: SubmitKey,
}

/// Every count not yet queued removed; queued batches keep theirs.
pub async fn clear(
    req: Req,
    State(legacy): State<Legacy>,
    Params(at): Params<url::ClearCounts>,
    Form(input): Form<ClearInput>,
) -> HtmlResult {
    pending::clear(&legacy, input.submit.as_str())
        .await
        .map_err(|message| corten::Error::new(message).with_status(StatusCode::BAD_GATEWAY))?;
    req.redirect(&url::InventoryManager {
        selection: at.selection,
        queued: None,
    })
}

/// The counts handed off as a pricing batch, with the cost and workflow chosen. Refused before
/// anything is sent when the counts moved since the screen showed them; the Node app refuses it
/// when the seller moved, and queues it once per submit key.
pub async fn queue_batch(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::QueueBatch>,
    Form(input): Form<QueueInput>,
) -> HtmlResult {
    let selection = at.selection;
    let input = input.filled();
    let cost = match input.read_cost() {
        Ok(cost) => cost,
        Err(errors) => {
            return refuse(&req, &db, &legacy, &selection, &input, &errors, None).await;
        }
    };
    let quantities = pending::quantities(&db).await?;
    // The counts moving on is a conflict; a submit without a way to queue is invalid input.
    let problem = match (input.workflow, &input.request) {
        _ if quantities.is_empty() => Some((
            Refusal::Conflict,
            "No saved inventory is available to queue.",
        )),
        _ if queue::fingerprint(&quantities) != input.counted => Some((
            Refusal::Conflict,
            "The shared inventory queue changed. Review the refreshed quantities and queue again. No inventory was handed off.",
        )),
        (None, _) | (_, None) => Some((Refusal::Invalid, "Choose a way to queue the batch.")),
        _ => None,
    };
    let (Some(workflow), Some(key), None) = (input.workflow, &input.request, problem) else {
        let mut errors = Errors::new();
        if let Some((why, message)) = problem {
            errors.refuse(why, message);
        }
        return refuse(
            &req,
            &db,
            &legacy,
            &selection,
            &input,
            &errors,
            Some(&quantities),
        )
        .await;
    };
    let expected = queue::snapshot(&quantities);
    let request = Queue {
        workflow,
        cost: &cost,
        expected: &expected,
        seller_key: &input.seller,
    };
    let queued = match queue::queue(&legacy, key.as_str(), &request).await {
        Ok(queued) => queued,
        Err(message) => {
            let mut errors = Errors::new();
            errors.refuse(Refusal::Conflict, message);
            let quantities = pending::quantities(&db).await?;
            return refuse(
                &req,
                &db,
                &legacy,
                &selection,
                &input,
                &errors,
                Some(&quantities),
            )
            .await;
        }
    };
    if req.mode != Mode::Action {
        return req.redirect(&url::InventoryManager {
            selection,
            queued: Some(queued.batch_number),
        });
    }
    let notice = format!(
        "Batch {} queued with {}. You can keep adding inventory.",
        queued.batch_number,
        cost.described()
    );
    let (screen, batches) = tokio::join!(Screen::read(&db, &selection), queue::batches(&legacy));
    let screen = screen?;
    let handed_off: HashSet<i32> = expected.iter().map(|i| i.sku).collect();
    let redrawn = redrawn(&screen.products, &handed_off);
    let next = input.after_queue();
    let none = Errors::new();
    let batches = batches.as_ref().map_err(String::as_str);
    let again = url::Batches {
        selection: selection.clone(),
    };
    req.patch(html! {
        <QueueNotice message={Some(&notice)} />
        <QueueTotals totals={screen.totals} counted={&queue::fingerprint(&screen.quantities)} />
        <ClearConfirm selection={&selection} totals={screen.totals} />
        <QueueForm
            selection={&selection}
            input={&next}
            target={batches.ok().map(|b| &b.target)}
            errors={&none}
        />
        <BackgroundBatches selection={&selection} batches={batches} refused={None} />
        {ReadAgain { after: BATCHES_EVERY }.from(&again)}
        for field in &redrawn {
            let counted = field.counted();
            <CountForm
                counted={&counted}
                quantity={screen.quantities.get(&counted.sku).copied().unwrap_or(0)}
                selection={&selection}
            />
        }
    })
}

/// A queue refused, with the refusal's status: the form with why, and, when the counts are read
/// again, the totals they come to now. Without JavaScript, the whole screen. Not `req.invalid`:
/// the form reads the Node app's batches, which the whole screen reads for itself.
async fn refuse(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    selection: &Selection,
    input: &QueueInput,
    errors: &Errors,
    quantities: Option<&HashMap<i32, i32>>,
) -> HtmlResult {
    if req.mode != Mode::Action {
        let drawn = Drawn {
            input: Some(input),
            errors: Some(errors),
            ..Drawn::default()
        };
        let mut answer = page(req, db, legacy, selection, &drawn).await?;
        *answer.status_mut() = errors.refusal().status();
        return Ok(answer);
    }
    let batches = queue::batches(legacy).await;
    let target = batches.as_ref().ok().map(|b| &b.target);
    let form = html! {
        <QueueForm selection={selection} input={input} target={target} errors={errors} />
    };
    let status = errors.refusal().status();
    match quantities {
        None => req.patch_with_status(status, form),
        Some(quantities) => {
            let totals = Totals::of(quantities);
            req.patch_with_status(
                status,
                html! {
                    {form}
                    <QueueTotals totals={totals} counted={&queue::fingerprint(quantities)} />
                    <ClearConfirm selection={selection} totals={totals} />
                },
            )
        }
    }
}

/// The background batches as they are now, and the request to read them again.
pub async fn batches(
    req: Req,
    State(legacy): State<Legacy>,
    Params(at): Params<url::Batches>,
) -> HtmlResult {
    let batches = queue::batches(&legacy).await;
    let selection = &at.selection;
    let again = url::Batches {
        selection: selection.clone(),
    };
    req.patch_or(
        html! {
            <BackgroundBatches
                selection={selection}
                batches={batches.as_ref().map_err(String::as_str)}
                refused={None}
            />
            {ReadAgain { after: BATCHES_EVERY }.from(&again)}
        },
        || async {
            req.redirect(&url::InventoryManager {
                selection: selection.clone(),
                queued: None,
            })
        },
    )
    .await
}

/// A queued batch's estimate rate as typed.
#[derive(Clone, Debug, Deserialize, Fields)]
pub struct RateInput {
    pub market_percent: String,
    pub per_card_deduction: String,
}

impl RateInput {
    fn read(&self) -> Result<CostRate, Errors> {
        let f = RateInput::FIELDS;
        let mut errors = Errors::new();
        let percent = queue::read_market_percent(&self.market_percent);
        let deduction = queue::read_per_card_deduction(&self.per_card_deduction);
        match (percent, deduction) {
            (Ok(market_rate), Ok(per_unit_deduction_cents)) => Ok(CostRate {
                market_rate,
                per_unit_deduction_cents,
            }),
            (percent, deduction) => {
                if let Err(message) = percent {
                    errors.add(f.market_percent, message);
                }
                if let Err(message) = deduction {
                    errors.add(f.per_card_deduction, message);
                }
                Err(errors)
            }
        }
    }
}

/// A queued batch estimated again at another rate; the earlier estimate stays in its history.
pub async fn change_rate(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::ChangeRate>,
    Form(input): Form<RateInput>,
) -> HtmlResult {
    let changed = match input.read() {
        Ok(rate) => queue::change_rate(&legacy, at.batch, rate)
            .await
            .map_err(|message| {
                let mut errors = Errors::new();
                errors.add_form(message);
                errors
            }),
        Err(errors) => Err(errors),
    };
    let selection = at.selection;
    if req.mode != Mode::Action {
        return match changed {
            Ok(()) => req.redirect(&url::InventoryManager {
                selection,
                queued: None,
            }),
            Err(errors) => {
                let message: Vec<&str> = errors
                    .form()
                    .into_iter()
                    .chain(errors.iter().map(|(_, m)| m))
                    .collect();
                let message = format!(
                    "Batch {}'s rate was not changed: {}",
                    at.batch,
                    message.join(" ")
                );
                let drawn = Drawn {
                    error: Some(&message),
                    ..Drawn::default()
                };
                let mut answer = page(&req, &db, &legacy, &selection, &drawn).await?;
                *answer.status_mut() = StatusCode::UNPROCESSABLE_ENTITY;
                Ok(answer)
            }
        };
    }
    let batches = queue::batches(&legacy).await;
    let refused = changed.as_ref().err().map(|errors| (at.batch, errors));
    let status = if refused.is_some() {
        StatusCode::UNPROCESSABLE_ENTITY
    } else {
        StatusCode::OK
    };
    let again = url::Batches {
        selection: selection.clone(),
    };
    req.patch_with_status(
        status,
        html! {
            <BackgroundBatches
                selection={&selection}
                batches={batches.as_ref().map_err(String::as_str)}
                refused={refused}
            />
            {ReadAgain { after: BATCHES_EVERY }.from(&again)}
        },
    )
}
