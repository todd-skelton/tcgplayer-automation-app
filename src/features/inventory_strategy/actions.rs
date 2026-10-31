//! The screen and its posts. A post sends the browser back to the screen it came from (its scope
//! is the post's query), saying what it did; a refusal is that screen with why, as a conflict.
use corten::{ClientZone, Refusal, prelude::*};
use serde::Deserialize;
use serde_json::json;

use super::{
    analysis_queue,
    screen::{self, Screen},
    turnaround::Mode,
    turnaround_settings::{self, Change, MAXIMUM_MANUAL_DAYS},
    url::{self, View},
    views::{AnalysisStatus, BatchState, Did, Problem, StrategyScreen, TurnaroundForm},
};
use crate::{
    database::Database,
    features::inventory_economics::ledger::fingerprint::js_float,
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

pub async fn show(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::InventoryStrategy>,
) -> HtmlResult {
    let screen = Screen::read(&db, &at.view, Visitor::of(zone.as_ref())).await?;
    let input = TurnaroundInput::of(&screen);
    page(&req, &db, &screen, &input, &Errors::new()).await
}

async fn page(
    req: &Req,
    db: &Database,
    screen: &Screen,
    input: &TurnaroundInput,
    errors: &Errors,
) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={req} title="Inventory Strategy" chrome={chrome} head="">
            <StrategyScreen screen={screen} input={input} errors={errors} t={t} />
        </Layout>
    })
}

/// The turnaround form as it is sent: for the seller the screen showed.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct TurnaroundInput {
    #[serde(default)]
    pub seller_key: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub manual_turnaround_days: String,
}

impl TurnaroundInput {
    pub fn of(screen: &Screen) -> Self {
        let setting = &screen.turnaround.setting;
        TurnaroundInput {
            seller_key: screen.dashboard.seller_key.clone(),
            mode: setting.mode.as_str().to_owned(),
            manual_turnaround_days: js_float(setting.manual_turnaround_days),
        }
    }

    /// The change the form asks for, or what is wrong with it.
    pub fn read(&self) -> Result<Change, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mode = Mode::parse(&self.mode).unwrap_or_else(|| {
            errors.add(f.mode, "Choose observed or manual.");
            Mode::Observed
        });
        let days = match self.manual_turnaround_days.trim().parse::<f64>() {
            Ok(d) if (0.0..=MAXIMUM_MANUAL_DAYS).contains(&d) => d,
            _ => {
                errors.add(
                    f.manual_turnaround_days,
                    format!("Enter a number of days from 0 to {MAXIMUM_MANUAL_DAYS}."),
                );
                0.0
            }
        };
        errors.into_result(Change {
            seller_key: self.seller_key.clone(),
            product_line_id: None,
            mode,
            manual_turnaround_days: days,
        })
    }
}

/// Saves the seller's turnaround source and manual days, unless the configured seller changed
/// since the screen was drawn.
pub async fn save_turnaround(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::SaveTurnaround>,
    Form(input): Form<TurnaroundInput>,
) -> HtmlResult {
    let errors = match input.read() {
        Ok(change) => match turnaround_settings::save_for_configured_seller(&db, &change).await {
            Ok(_) => {
                let t: Msg = req.t();
                return req.redirect_with_notice(
                    &url::InventoryStrategy { view: at.view },
                    Did::Saved.said(t),
                );
            }
            Err(why) => {
                let mut errors = Errors::new();
                errors.refuse(Refusal::Conflict, why);
                errors
            }
        },
        Err(errors) => errors,
    };
    let view = at.view.clone();
    let form = TurnaroundForm {
        view: &view,
        input: &input,
        errors: &errors,
    };
    req.invalid(&errors, form, || async {
        let screen = Screen::read(&db, &view, Visitor::of(zone.as_ref())).await?;
        page(&req, &db, &screen, &input, &errors).await
    })
    .await
}

/// Reads the seller's whole inventory from TCGplayer again, on the Node app.
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
        Ok(done) => {
            let t: Msg = req.t();
            req.redirect_with_notice(
                &url::InventoryStrategy { view: at.view },
                Did::Refreshed { count: done.count }.said(t),
            )
        }
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// Queues a strategy analysis of the in-stock snapshot for the pricing worker, or names the one
/// already running.
pub async fn queue_analysis(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::QueueAnalysis>,
) -> HtmlResult {
    match analysis_queue::queue_analysis(&db).await {
        Ok(q) => {
            let did = if q.created {
                Did::Queued {
                    batch: q.batch_number,
                    items: q.item_count,
                }
            } else {
                Did::AlreadyQueued {
                    batch: q.batch_number,
                    state: BatchState::of(&q.status),
                }
            };
            let t: Msg = req.t();
            req.redirect_with_notice(&url::InventoryStrategy { view: at.view }, did.said(t))
        }
        Err(why) => refused(&req, &db, zone, &at.view, why).await,
    }
}

/// The latest analysis while it runs, read again by the screen; once it ends, the whole screen
/// as it is with its results, as the React screen revalidated.
pub async fn analysis(
    req: Req,
    State(db): State<Database>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Analysis>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let t: Msg = req.t();
    let view = at.view.clone();
    let back = || async { req.redirect(&url::InventoryStrategy { view: view.clone() }) };
    match screen::analysis(&db, at.batch).await? {
        Some(running) if running.active() => {
            let status = AnalysisStatus {
                analysis: &running,
                view: &view,
                t,
                visitor,
            };
            req.patch_or(status, back).await
        }
        _ if req.mode != corten::Mode::Action => back().await,
        _ => {
            let screen = Screen::read(&db, &view, visitor).await?;
            let input = TurnaroundInput::of(&screen);
            req.patch(StrategyScreen {
                screen: &screen,
                input: &input,
                errors: &Errors::new(),
                t,
            })
        }
    }
}

/// Why the post was refused, as a conflict: with JavaScript only the message; otherwise the
/// screen the post came from.
async fn refused(
    req: &Req,
    db: &Database,
    zone: Option<ClientZone>,
    view: &View,
    why: String,
) -> HtmlResult {
    let mut refusal = Errors::new();
    refusal.refuse(Refusal::Conflict, why.as_str());
    let message = html! { <Problem why={Some(why.as_str())} /> };
    req.invalid(&refusal, message, || async {
        let mut screen = Screen::read(db, &view.clone(), Visitor::of(zone.as_ref())).await?;
        screen.problem = Some(why.clone());
        let input = TurnaroundInput::of(&screen);
        page(req, db, &screen, &input, &Errors::new()).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: &str, days: &str) -> TurnaroundInput {
        TurnaroundInput {
            seller_key: "s".into(),
            mode: mode.into(),
            manual_turnaround_days: days.into(),
        }
    }

    #[test]
    fn the_form_reads_as_a_change_for_the_seller() {
        let change = input("manual", "21.5").read().unwrap();
        assert_eq!(
            (
                change.mode,
                change.manual_turnaround_days,
                change.product_line_id
            ),
            (Mode::Manual, 21.5, None)
        );
    }

    #[test]
    fn days_out_of_range_or_an_unknown_mode_are_refused() {
        let f = TurnaroundInput::FIELDS;
        let errors = input("weekly", "3651").read().unwrap_err();
        assert!(errors.has(f.mode) && errors.has(f.manual_turnaround_days));
        assert!(input("observed", "-1").read().is_err());
        assert!(input("observed", "0").read().is_ok());
    }
}
