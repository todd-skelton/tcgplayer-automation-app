use std::{collections::HashMap, time::SystemTime};

use chrono::{Duration, Utc};
use corten::{ClientZone, axum::http::StatusCode, i18n::Zone, prelude::*};
use serde::{Deserialize, Serialize};

use super::{
    postage::{self, Postage},
    ship::Pending,
    shipments::{Batch, Direction},
    source,
    steps::{Counts, Step},
    url::{self, ShippingWorkflow},
    value,
    views::{
        LoadOrdersStep, Loading, PullSheetStep, Pulled, SaleValueFigures, ShippingWorkflowScreen,
        StepBar,
    },
    workflow::{self, Saved, Workflow},
};
use crate::{
    database::Database,
    features::{
        pull_sheet::{self, Summary, url::SheetQuery},
        shipping_configuration::{self, EasyPostMode, ShippingConfig},
    },
    layout::{Chrome, Layout, Notice, Tone},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// How long the orders' intake history is used before it is read again, as the React screen
/// read it every five minutes.
const INTAKE_FOR: Duration = Duration::minutes(5);
/// The largest older order CSV the Node app takes.
const MOST_HISTORY: usize = 5 << 20;

impl ShippingWorkflow {
    pub fn at(step: Step) -> Self {
        ShippingWorkflow {
            step: Some(step),
            seller: None,
            filters: SheetQuery::default(),
        }
    }
}

/// The names of the page's own query fields, for the seller's GET form.
#[derive(Deserialize, Fields)]
#[expect(
    dead_code,
    reason = "the struct only names the GET form's fields; the route reads them"
)]
pub struct At {
    pub step: Option<Step>,
    pub seller: Option<String>,
}

/// The batch in progress as the page draws it: the orders planned into shipments under the
/// current settings, with the shipments edited by hand in place, and the postage bought for them.
struct Shown {
    config: ShippingConfig,
    saved: Option<Saved>,
    batch: Batch,
    postage: Result<Postage, String>,
}

impl Shown {
    async fn read(db: &Database, legacy: &Legacy) -> corten::Result<Shown> {
        let (config, saved) =
            tokio::join!(shipping_configuration::settings(db), workflow::current(db));
        let (config, mut saved) = (config?, saved?);
        if let Some(s) = &mut saved {
            refresh_intake(db, legacy, &config, &mut s.workflow).await?;
        }
        let mut batch = Batch::plan(
            saved
                .as_ref()
                .map_or_else(Vec::new, |s| s.workflow.orders.clone()),
            &config,
        );
        if let Some(s) = &saved {
            for planned in &mut batch.shipments {
                if let Some(edited) = s.workflow.edits.get(planned.reference()) {
                    planned.shipment = edited.clone();
                }
            }
        }
        let postage = postage::bought(legacy, Direction::Outbound, &batch.shipments).await;
        Ok(Shown {
            config,
            saved,
            batch,
            postage,
        })
    }

    fn workflow(&self) -> Option<&Workflow> {
        self.saved.as_ref().map(|s| &s.workflow)
    }

    fn purchased(&self) -> usize {
        let Ok(postage) = &self.postage else { return 0 };
        self.batch
            .shipments
            .iter()
            .filter(|p| postage.get(p.reference()).is_some_and(|b| b.purchased()))
            .count()
    }

    fn pending(&self) -> Pending {
        let (empty, none) = (Postage::new(), Workflow::default());
        let w = self.workflow().unwrap_or(&none);
        Pending::of(
            &self.batch.orders,
            &self.batch.shipments,
            self.postage.as_ref().unwrap_or(&empty),
            &w.tracked,
            &w.messaged,
            &w.seller_key,
        )
    }

    fn counts(&self) -> Counts {
        let pending = self.pending();
        let has_seller = self
            .workflow()
            .is_some_and(|w| !w.seller_key.trim().is_empty());
        let production = pending.tracking.len() + pending.already_tracked;
        let shipped = if has_seller {
            production.saturating_sub(pending.orders().len())
        } else {
            0
        };
        Counts {
            orders: self.batch.orders.len(),
            items: self.batch.item_count(),
            shipments: self.batch.shipments.len(),
            purchased: self.purchased(),
            packed: self.workflow().map_or(0, |w| w.packed.len()),
            unshipped: production - shipped,
            shipped,
            has_seller,
        }
    }

    /// The first step not done: where a visit without a step opens.
    fn resume(&self, c: Counts) -> Step {
        if c.orders == 0 {
            Step::LoadOrders
        } else if c.purchased == 0 {
            Step::PullSheet
        } else if c.purchased < c.shipments {
            Step::BuyPostage
        } else if c.packed == 0 {
            Step::Print
        } else if c.packed < c.shipments {
            Step::Pack
        } else {
            Step::Ship
        }
    }
}

/// Reads the orders' intake history again once it is older than [`INTAKE_FOR`], and keeps it.
/// It is only for the configured seller (the Node app refuses another); one that cannot be read
/// is dropped with a warning, as the React screen dropped it.
async fn refresh_intake(
    db: &Database,
    legacy: &Legacy,
    config: &ShippingConfig,
    w: &mut Workflow,
) -> sqlx::Result<()> {
    let fresh = w
        .intake_read_at
        .is_some_and(|at| Utc::now() - at < INTAKE_FOR);
    let configured = config.default_seller_key.trim();
    if fresh || w.orders.is_empty() || configured.is_empty() || w.seller_key.trim() != configured {
        return Ok(());
    }
    let mut orders = w.orders.clone();
    let read = source::intake_history(legacy, configured, &mut orders).await;
    let numbers: Vec<String> = orders.iter().map(|o| o.number.clone()).collect();
    let changed = workflow::change(db, move |stored| {
        // A batch loaded while this was read is not this one.
        if stored.orders.iter().map(|o| &o.number).ne(numbers.iter()) {
            return;
        }
        match read {
            Ok(()) => stored.orders = orders,
            Err(why) => {
                for order in &mut stored.orders {
                    order.intake_history = None;
                }
                let warning = format!("Intake history refresh failed: {why}");
                if !stored.warnings.contains(&warning) {
                    stored.warnings.push(warning);
                }
            }
        }
        stored.intake_read_at = Some(Utc::now());
    })
    .await?;
    if changed.is_some()
        && let Some(saved) = workflow::current(db).await?
    {
        *w = saved.workflow;
    }
    Ok(())
}

/// The batch's pull sheet: TCGplayer's for the orders, read with the catalog.
async fn pull(
    db: &Database,
    legacy: &Legacy,
    batch: &Batch,
    visitor: Visitor,
    filters: &SheetQuery,
) -> Result<Pulled, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        order_numbers: &'a [String],
        timezone_offset: f64,
    }
    let numbers = batch.order_numbers();
    if numbers.is_empty() {
        return Err("Load orders first.".into());
    }
    let offset = f64::from(visitor.offset(SystemTime::now())) / 3600.0;
    let csv = legacy
        .send_for_file(
            "/api/shipping-export/pull-sheet-export",
            &Request {
                order_numbers: &numbers,
                timezone_offset: offset,
            },
        )
        .await?;
    let text = String::from_utf8_lossy(&csv.bytes);
    let (mut items, order_ids) = pull_sheet::read(db, text.trim_start_matches('\u{feff}')).await?;
    let summary = Summary::of(&items, order_ids.len());
    let values: HashMap<i64, value::SaleValue> = items
        .iter()
        .filter_map(|i| i.sku_id)
        .map(|sku| (sku, value::of_card(&batch.orders, sku)))
        .collect();
    pull_sheet::shown(&mut items, filters);
    Ok(Pulled {
        items,
        summary,
        values,
    })
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ShippingWorkflow>,
) -> HtmlResult {
    let at = url::ShippingWorkflow {
        step: at.step,
        seller: at.seller,
        filters: at.filters,
    };
    page(&req, &db, &legacy, Visitor::of(zone.as_ref()), &at, None).await
}

/// The page at `at`, with why the last post was refused when it was.
async fn page(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    at: &url::ShippingWorkflow,
    problem: Option<&str>,
) -> HtmlResult {
    let (chrome, shown) = tokio::join!(Chrome::read(db), Shown::read(db, legacy));
    let shown = shown?;
    let counts = shown.counts();
    let step = at.step.unwrap_or_else(|| shown.resume(counts));
    let progress = step.progress(counts);
    let t: Msg = req.t();
    let workflow = shown.workflow();
    let seller = at
        .seller
        .as_deref()
        .or(workflow.map(|w| w.seller_key.as_str()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&shown.config.default_seller_key)
        .trim()
        .to_owned();
    let pulled = match step {
        Step::PullSheet => Some(pull(db, legacy, &shown.batch, visitor, &at.filters).await),
        _ => None,
    };
    let coverage = match step {
        Step::LoadOrders if !seller.is_empty() => Some(source::coverage(legacy, &seller).await),
        _ => None,
    };
    let postage_problem = shown
        .postage
        .as_ref()
        .err()
        .map(|why| format!("Failed to load saved postage: {why}"));
    let problem = problem.or(postage_problem.as_deref());
    let batch_value =
        (!shown.batch.orders.is_empty()).then(|| value::of_orders(&shown.batch.orders));
    let unshipped = (counts.unshipped > 0).then(|| {
        format!(
            "{} {} not yet marked shipped with the buyer notified. Starting a new batch clears this one.",
            counts.unshipped,
            if counts.unshipped == 1 { "order is" } else { "orders are" }
        )
    });
    let none = Vec::new();
    let loading = Loading {
        seller: &seller,
        configured: shown.config.default_seller_key.trim(),
        source: workflow.map(|w| (w.source.as_str(), w.orders.len())),
        warnings: workflow.map_or(&none, |w| &w.warnings),
        coverage,
    };
    let batch = &shown.batch;
    req.page(html! {
        <Layout req={req} title="Shipping Workflow" chrome={chrome} head="">
            <ShippingWorkflowScreen
                step={step}
                mode={EasyPostMode::of_deployment()}
                problem={problem}
                bar={&html! {
                    <StepBar
                        step={step}
                        progress={&progress}
                        value={&html! {
                            if let Some(value) = &batch_value {
                                <SaleValueFigures value={value} on_image={false} t={t} />
                            }
                        }}
                        action={&""}
                        unshipped_warning={unshipped.as_deref()}
                    />
                }}
            >
                match step {
                    Step::LoadOrders => <LoadOrdersStep loading={&loading} />,
                    Step::PullSheet => {
                        if let Some(pulled) = &pulled {
                            <PullSheetStep
                                pulled={pulled}
                                batch={batch}
                                filters={&at.filters}
                                t={t}
                            />
                        }
                    }
                    _ => {
                        <Notice tone={Tone::Info}>
                            "This step is still being ported. Use the React screen for it until it lands."
                        </Notice>
                    }
                }
            </ShippingWorkflowScreen>
        </Layout>
    })
}

/// The page with why a post was refused, as a conflict.
async fn refused(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    step: Step,
    why: &str,
) -> HtmlResult {
    let mut page = page(
        req,
        db,
        legacy,
        visitor,
        &ShippingWorkflow::at(step),
        Some(why),
    )
    .await?;
    *page.status_mut() = StatusCode::CONFLICT;
    Ok(page)
}

#[derive(Deserialize, Fields)]
pub struct LoadInput {
    #[serde(default)]
    pub seller_key: String,
    #[serde(default)]
    pub order_number: String,
}

/// Orders loaded as a new batch, replacing the one in progress.
async fn start(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    loaded: Result<source::Loaded, String>,
    source_of: impl FnOnce(&source::Loaded) -> String,
) -> HtmlResult {
    let loaded = match loaded {
        Ok(loaded) => loaded,
        Err(why) => return refused(req, db, legacy, visitor, Step::LoadOrders, &why).await,
    };
    let configured = shipping_configuration::default_seller_key(db).await?;
    let mut fresh = Workflow::loaded(
        loaded.seller_key.clone(),
        source_of(&loaded),
        loaded.warnings,
        loaded.orders,
    );
    // The Node app attaches the intake history when the seller is the configured one.
    if !configured.trim().is_empty() && fresh.seller_key.trim() == configured.trim() {
        fresh.intake_read_at = Some(Utc::now());
    }
    workflow::replace(db, &fresh).await?;
    req.redirect(&ShippingWorkflow::at(Step::LoadOrders))
}

pub async fn load_orders(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Form(input): Form<LoadInput>,
) -> HtmlResult {
    let loaded = source::ready_to_ship(&legacy, input.seller_key.trim()).await;
    start(
        &req,
        &db,
        &legacy,
        Visitor::of(zone.as_ref()),
        loaded,
        |l| format!("Live seller orders: {}", l.seller_key),
    )
    .await
}

pub async fn load_order(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Form(input): Form<LoadInput>,
) -> HtmlResult {
    let number = input.order_number.trim().to_owned();
    let visitor = Visitor::of(zone.as_ref());
    if number.is_empty() {
        let why = "Enter a TCGPlayer order number to load a single order.";
        return refused(&req, &db, &legacy, visitor, Step::LoadOrders, why).await;
    }
    let loaded = source::one(&legacy, input.seller_key.trim(), &number).await;
    start(&req, &db, &legacy, visitor, loaded, |l| {
        format!(
            "Single TCGPlayer order: {}",
            l.loaded_order_numbers.first().unwrap_or(&number)
        )
    })
    .await
}

#[derive(Deserialize, Fields)]
pub struct HistoryInput {
    #[serde(default)]
    pub seller_key: String,
    pub file: Files,
}

/// After the seller's order history changed, the batch's intake history is read again.
async fn history_changed(
    req: &Req,
    db: &Database,
    done: Result<(), String>,
    legacy: &Legacy,
    visitor: Visitor,
) -> HtmlResult {
    if let Err(why) = done {
        let why = format!("Failed to update seller order history: {why}");
        return refused(req, db, legacy, visitor, Step::LoadOrders, &why).await;
    }
    workflow::change(db, |w| w.intake_read_at = None).await?;
    req.redirect(&ShippingWorkflow::at(Step::LoadOrders))
}

#[derive(Deserialize, Fields)]
pub struct CatchUpInput {
    #[serde(default)]
    pub seller_key: String,
}

/// The seller's order history scan moved on, the batch's orders first.
pub async fn catch_up(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Form(input): Form<CatchUpInput>,
) -> HtmlResult {
    let orders: Vec<String> = workflow::current(&db).await?.map_or_else(Vec::new, |s| {
        s.workflow.orders.into_iter().map(|o| o.number).collect()
    });
    let done = source::catch_up(&legacy, input.seller_key.trim(), &orders).await;
    history_changed(&req, &db, done, &legacy, Visitor::of(zone.as_ref())).await
}

/// An order export older than the API's window added to the seller's order history.
pub async fn import_history(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    mut upload: Upload<HistoryInput>,
) -> HtmlResult {
    let f = HistoryInput::FIELDS;
    upload.limit(MOST_HISTORY + (64 << 10));
    let mut chosen = None;
    let mut problem = None;
    while let Some(mut file) = upload.next_file().await? {
        if file.is(f.file) {
            let name = file.filename().to_string();
            match file.bytes_up_to(MOST_HISTORY).await? {
                Some(bytes) if !bytes.is_empty() => chosen = Some((name, bytes)),
                Some(_) => {}
                None => problem = Some("Seller order CSV exceeds the 5 MB limit.".to_owned()),
            }
        }
    }
    let fields = upload.fields().await?;
    let seller = fields.seller_key.trim().to_owned();
    let done = match (problem, chosen) {
        (Some(why), _) => Err(why),
        (None, None) => Err("A seller order CSV file is required.".to_owned()),
        (None, Some((name, bytes))) => {
            let text = String::from_utf8_lossy(&bytes);
            source::import_history(&legacy, &seller, &name, &text).await
        }
    };
    history_changed(&req, &db, done, &legacy, Visitor::of(zone.as_ref())).await
}

/// The batch dropped; the screen starts again at Load Orders.
pub async fn new_batch(req: Req, State(db): State<Database>) -> HtmlResult {
    workflow::replace(&db, &Workflow::default()).await?;
    req.redirect(&ShippingWorkflow::at(Step::LoadOrders))
}
