//! The screen and its posts. A post sends the browser back to the page it came from, saying what
//! it did; a refusal is that page with why, as a conflict.
// A refusal sets its status on the drawn page by hand (corten#438), and every handler takes the
// visitor's zone so the page's dates are the visitor's (corten#387).
use corten::{ClientZone, Mode, axum::http::StatusCode, prelude::*};
use serde::Deserialize;
use serde_json::json;

use super::{
    store::{self, Settings},
    url::{self, View},
    views::{ContinuousScreen, Cycle, Done, Problem, ScheduleForm},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// Everything the page shows.
pub struct Screen {
    pub view: View,
    pub settings: Settings,
    pub status: store::Status,
    pub page: store::Page,
    pub runs: Vec<store::Run>,
    pub visitor: Visitor,
    /// Why the last post was refused.
    pub problem: Option<String>,
}

impl Screen {
    pub async fn read(db: &Database, view: &View, visitor: Visitor) -> corten::Result<Screen> {
        let settings = store::settings(db).await?;
        let seller = settings.seller_key.as_str();
        let (status, page, runs) = if seller.is_empty() {
            (store::Status::default(), store::Page::default(), Vec::new())
        } else {
            (
                store::status(db, seller).await?,
                store::page(
                    db,
                    seller,
                    view.search(),
                    view.shown(),
                    view.page.unwrap_or(1),
                )
                .await?,
                store::recent_runs(db).await?,
            )
        };
        Ok(Screen {
            view: view.clone(),
            settings,
            status,
            page,
            runs,
            visitor,
            problem: None,
        })
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ContinuousPricing>,
) -> HtmlResult {
    let screen = Screen::read(&db, &at.view, Visitor::of(zone.as_ref())).await?;
    let input = ScheduleInput::of(&screen.settings);
    page(&req, &db, &screen, &input, &Errors::new()).await
}

async fn page(
    req: &Req,
    db: &Database,
    screen: &Screen,
    input: &ScheduleInput,
    errors: &Errors,
) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={req} title="Continuous Pricing" chrome={chrome} head="">
            <ContinuousScreen screen={screen} input={input} errors={errors} t={t} />
        </Layout>
    })
}

/// The schedule as the form sends it. The poll interval is not on the form and keeps its value.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct ScheduleInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub seller_key: String,
    pub minimum_interval_minutes: String,
    pub inventory_refresh_minutes: String,
    pub batch_size: String,
}

impl ScheduleInput {
    pub fn of(settings: &Settings) -> Self {
        ScheduleInput {
            enabled: settings.enabled,
            seller_key: settings.seller_key.clone(),
            minimum_interval_minutes: settings.minimum_interval_minutes.to_string(),
            inventory_refresh_minutes: settings.inventory_refresh_minutes.to_string(),
            batch_size: settings.batch_size.to_string(),
        }
    }

    /// The schedule the form says, or what is wrong with it. The React screen saved an
    /// out-of-range number as its default without saying so.
    pub fn read(&self, saved: &Settings) -> Result<Settings, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mut whole = |field, text: &str, range: std::ops::RangeInclusive<i64>| match text
            .trim()
            .parse::<i64>(
        ) {
            Ok(n) if range.contains(&n) => n,
            _ => {
                let (low, high) = range.into_inner();
                errors.add(field, format!("Enter a whole number from {low} to {high}."));
                low
            }
        };
        let minimum_interval_minutes = whole(
            f.minimum_interval_minutes,
            &self.minimum_interval_minutes,
            store::range::MINIMUM_INTERVAL,
        );
        let inventory_refresh_minutes = whole(
            f.inventory_refresh_minutes,
            &self.inventory_refresh_minutes,
            store::range::INVENTORY_REFRESH,
        );
        let batch_size = whole(f.batch_size, &self.batch_size, store::range::BATCH_SIZE);
        let seller_key: String = self.seller_key.trim().chars().take(200).collect();
        if self.enabled && seller_key.is_empty() {
            errors.add(
                f.seller_key,
                "A seller key is required before continuous pricing can run.",
            );
        }
        errors.into_result(Settings {
            enabled: self.enabled,
            seller_key,
            minimum_interval_minutes,
            inventory_refresh_minutes,
            scheduler_poll_seconds: saved.scheduler_poll_seconds,
            batch_size,
        })
    }
}

pub async fn save(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::SaveSchedule>,
    Form(input): Form<ScheduleInput>,
) -> HtmlResult {
    let saved = store::settings(&db).await?;
    match input.read(&saved) {
        Ok(settings) => {
            store::save(&db, &settings).await?;
            req.redirect(&url::ContinuousPricing {
                view: View {
                    done: Some(Done::Saved),
                    ..at.view.quiet()
                },
            })
        }
        Err(errors) => {
            let screen = Screen::read(&db, &at.view.quiet(), Visitor::of(zone.as_ref())).await?;
            let form = ScheduleForm {
                screen: &screen,
                input: &input,
                errors: &errors,
            };
            req.invalid(&errors, form, || page(&req, &db, &screen, &input, &errors))
                .await
        }
    }
}

/// A scheduler cycle's outcome, as the Node app answers it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ran {
    status: Cycle,
    batch_number: Option<i32>,
    item_count: Option<i64>,
}

impl Ran {
    fn into_view(self, view: View) -> View {
        View {
            cycle: Some(self.status),
            batch: self.batch_number,
            items: self.item_count,
            ..view
        }
    }
}

/// Reads the seller's whole inventory from TCGplayer again, with its market prices.
pub async fn refresh(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Refresh>,
) -> HtmlResult {
    #[derive(Deserialize)]
    struct Refreshed {
        count: i64,
    }
    match legacy
        .send::<_, Refreshed>("/api/continuous-pricing", &json!({ "intent": "refresh" }))
        .await
    {
        Ok(done) => req.redirect(&url::ContinuousPricing {
            view: View {
                done: Some(Done::Refreshed),
                count: Some(done.count),
                ..at.view.quiet()
            },
        }),
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// Runs a scheduler cycle now: a refresh when one is due, then a batch of the SKUs due.
pub async fn run(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Run>,
) -> HtmlResult {
    #[derive(Deserialize)]
    struct Cycled {
        cycle: Ran,
    }
    match legacy
        .send::<_, Cycled>("/api/continuous-pricing", &json!({ "intent": "run" }))
        .await
    {
        Ok(done) => req.redirect(&url::ContinuousPricing {
            view: done.cycle.into_view(View {
                done: Some(Done::Ran),
                ..at.view.quiet()
            }),
        }),
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// Reprices the inventory from saved curves where the data allows, and makes the rest due.
pub async fn apply_policy(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ApplyPolicy>,
) -> HtmlResult {
    #[derive(Deserialize)]
    struct Applied {
        cached: i64,
        batches: i64,
        remaining: i64,
    }
    match legacy
        .send::<_, Applied>(
            "/api/continuous-pricing",
            &json!({ "intent": "apply_policy" }),
        )
        .await
    {
        Ok(done) => req.redirect(&url::ContinuousPricing {
            view: View {
                done: Some(Done::Applied),
                count: Some(done.cached),
                batches: Some(done.batches),
                remaining: Some(done.remaining),
                ..at.view.quiet()
            },
        }),
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// Makes every eligible SKU due for fresh market-data pricing, then runs a cycle.
pub async fn mark_due(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::MarkDue>,
) -> HtmlResult {
    #[derive(Deserialize)]
    struct Marked {
        count: i64,
        cycle: Ran,
    }
    match legacy
        .send::<_, Marked>(
            "/api/continuous-pricing",
            &json!({ "intent": "reprice_all" }),
        )
        .await
    {
        Ok(done) => req.redirect(&url::ContinuousPricing {
            view: done.cycle.into_view(View {
                done: Some(Done::MarkedDue),
                count: Some(done.count),
                ..at.view.quiet()
            }),
        }),
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// A SKU to enable or pause. An unchecked switch sends nothing, which is paused.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct SkuInput {
    pub sku: i32,
    #[serde(default)]
    pub enabled: bool,
}

pub async fn set_sku(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::SetSku>,
    Form(input): Form<SkuInput>,
) -> HtmlResult {
    let settings = store::settings(&db).await?;
    if settings.seller_key.is_empty() {
        let why = "No continuous pricing seller is configured.".to_owned();
        return refused(&req, &db, zone, &at.view, why).await;
    }
    if input.sku <= 0
        || !store::set_enabled(&db, &settings.seller_key, input.sku, input.enabled).await?
    {
        let why = format!(
            "SKU {} is not in the seller's tracked inventory.",
            input.sku
        );
        return refused(&req, &db, zone, &at.view, why).await;
    }
    req.redirect(&url::ContinuousPricing {
        view: View {
            done: Some(if input.enabled {
                Done::Enabled
            } else {
                Done::Paused
            }),
            sku: Some(input.sku),
            ..at.view.quiet()
        },
    })
}

/// Why the post was refused, as a conflict: with JavaScript (a `data-patch` form) only the
/// message; otherwise the page the post came from.
async fn refused(
    req: &Req,
    db: &Database,
    zone: Option<ClientZone>,
    view: &View,
    why: String,
) -> HtmlResult {
    if req.mode == Mode::Action {
        let why = Some(why.as_str());
        return req.patch_with_status(StatusCode::CONFLICT, html! { <Problem why={why} /> });
    }
    let mut screen = Screen::read(db, &view.quiet(), Visitor::of(zone.as_ref())).await?;
    screen.problem = Some(why);
    let input = ScheduleInput::of(&screen.settings);
    let mut answer = page(req, db, &screen, &input, &Errors::new()).await?;
    *answer.status_mut() = StatusCode::CONFLICT;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_reads_back_as_the_schedule_keeping_the_poll_interval() {
        let saved = Settings {
            scheduler_poll_seconds: 45,
            seller_key: "abc".into(),
            ..Settings::default()
        };
        assert_eq!(ScheduleInput::of(&saved).read(&saved).unwrap(), saved);
    }

    #[test]
    fn a_schedule_out_of_range_or_enabled_without_a_seller_is_named() {
        let input = ScheduleInput {
            enabled: true,
            seller_key: "  ".into(),
            batch_size: "751".into(),
            ..ScheduleInput::of(&Settings::default())
        };
        let errors = input.read(&Settings::default()).unwrap_err();
        let f = ScheduleInput::FIELDS;
        assert_eq!(
            errors.get(f.batch_size),
            Some("Enter a whole number from 1 to 750.")
        );
        assert!(errors.has(f.seller_key));
        assert_eq!(errors.len(), 2);
    }
}
