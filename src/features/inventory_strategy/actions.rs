//! The screen and its posts. A post sends the browser back to the screen it came from (its scope
//! is the post's query), saying what it did; a refusal is that screen with why, as a conflict.
use corten::{Mode, Refusal, prelude::*};

use super::{
    analysis_queue,
    screen::{self, Screen},
    turnaround::{self, Selection},
    turnaround_settings::{self, Change, MAXIMUM_MANUAL_DAYS},
    url::{self, View},
    views::{
        AnalysisStatus, BatchState, Did, Problem, SellingHistoryPart, StrategyScreen,
        TurnaroundForm,
    },
};
use crate::{
    database::Database,
    features::{
        batch_pricing::market::TcgPlayerMarket, continuous_pricing,
        inventory_economics::ledger::fingerprint::js_float,
    },
    layout::Layout,
    tcgplayer::TcgPlayer,
    text::Msg,
};

/// The screen; a scope chosen with JavaScript (the selling history's `data-patch` form) is the
/// selling history for it alone.
pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::InventoryStrategy>,
) -> HtmlResult {
    if req.mode == Mode::Action {
        let t: Msg = req.t();
        let seller = continuous_pricing::store::settings(&db).await?.seller_key;
        let history = screen::load_selling_history(&db, &seller, &at.view.scope()).await;
        return req.patch(SellingHistoryPart {
            history: Some(&history),
            view: &at.view,
            t,
        });
    }
    let screen = Screen::read(&db, &at.view).await?;
    page(&req, &screen).await
}

async fn page(req: &Req, screen: &Screen) -> HtmlResult {
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={req} title="Inventory Strategy" head="">
            <StrategyScreen screen={screen} t={t} />
        </Layout>
    })
}

/// The turnaround form as it is sent: for the seller the screen showed.
#[derive(Clone, Debug, Default, Fields)]
pub struct TurnaroundInput {
    #[serde(default)]
    pub seller_key: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub manual_turnaround_days: String,
}

impl TurnaroundInput {
    pub fn of(seller_key: &str, selection: &Selection) -> Self {
        let setting = &selection.setting;
        TurnaroundInput {
            seller_key: seller_key.to_owned(),
            mode: setting.mode.as_str().to_owned(),
            manual_turnaround_days: js_float(setting.manual_turnaround_days),
        }
    }

    /// The change the form asks for, or what is wrong with it.
    pub fn read(&self) -> Result<Change, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let mode = turnaround::Mode::parse(&self.mode).unwrap_or_else(|| {
            errors.add(f.mode, "Choose observed or manual.");
            turnaround::Mode::Observed
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
    // Without JavaScript the page shows the refused form, so its turnaround is read in.
    req.invalid(&errors, form, || async {
        let mut screen = Screen::read(&db, &view.whole()).await?;
        screen.refused_turnaround = Some((input.clone(), errors.clone()));
        page(&req, &screen).await
    })
    .await
}

/// Reads the seller's whole inventory from TCGplayer again, with its market prices, as
/// Continuous Pricing's refresh does.
pub async fn refresh(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::Refresh>,
) -> HtmlResult {
    let settings = continuous_pricing::store::settings(&db).await?;
    if settings.seller_key.is_empty() {
        let why = "Save a seller key before refreshing inventory.".to_owned();
        return refused(&req, &db, &at.view, why).await;
    }
    let tcg = TcgPlayer::new(db.clone());
    let refreshed = continuous_pricing::refresh::refresh(
        &db,
        &settings.seller_key,
        settings.minimum_interval_minutes,
        &continuous_pricing::refresh::TcgPlayerSearch(tcg.clone()),
        &TcgPlayerMarket(tcg),
    )
    .await;
    match refreshed {
        Ok(count) => {
            let t: Msg = req.t();
            req.redirect_with_notice(
                &url::InventoryStrategy { view: at.view },
                Did::Refreshed {
                    count: count as i64,
                }
                .said(t),
            )
        }
        Err(why) => refused(&req, &db, &at.view, why).await,
    }
}

/// Queues a strategy analysis of the in-stock snapshot for the pricing worker, or names the one
/// already running.
pub async fn queue_analysis(
    req: Req,
    State(db): State<Database>,
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
        Err(why) => refused(&req, &db, &at.view, why).await,
    }
}

/// The latest analysis while it runs, read again by the screen; once it ends, the whole screen
/// as it is with its results, as the React screen revalidated (its slow parts sent again by its
/// streams).
pub async fn analysis(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::Analysis>,
) -> HtmlResult {
    let t: Msg = req.t();
    let view = at.view.clone();
    let back = || async { req.redirect(&url::InventoryStrategy { view: view.clone() }) };
    match screen::analysis(&db, at.batch).await? {
        Some(running) if running.active() => {
            let status = AnalysisStatus {
                analysis: &running,
                view: &view,
                t,
            };
            req.patch_or(status, back).await
        }
        _ if req.mode != corten::Mode::Action => back().await,
        _ => {
            let screen = Screen::read(&db, &view).await?;
            req.patch(StrategyScreen { screen: &screen, t })
        }
    }
}

/// Why the post was refused, as a conflict: with JavaScript only the message; otherwise the
/// screen the post came from.
async fn refused(req: &Req, db: &Database, view: &View, why: String) -> HtmlResult {
    let mut refusal = Errors::new();
    refusal.refuse(Refusal::Conflict, why.as_str());
    let message = html! { <Problem why={Some(why.as_str())} /> };
    req.invalid(&refusal, message, || async {
        let mut screen = Screen::read(db, &view.clone()).await?;
        screen.problem = Some(why.clone());
        page(req, &screen).await
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
            (turnaround::Mode::Manual, 21.5, None)
        );
    }

    #[test]
    fn the_address_names_the_slow_parts_the_page_reads_in() {
        let plain = View::default();
        assert!(!plain.reads_returns() && !plain.reads_selling_history());
        let scoped = View {
            history_days: Some(
                crate::features::inventory_strategy::selling_history::Window::Days365,
            ),
            ..View::default()
        };
        assert!(scoped.reads_selling_history() && !scoped.reads_returns());
        let whole = scoped.whole();
        assert!(whole.reads_returns() && whole.reads_selling_history());
        assert_eq!(whole.scope(), scoped.scope());
    }

    /// The screen's answer for `path` from the dev database (`.env`), with JavaScript (a
    /// `data-patch` submit) or as a page. Reads only, as `app`'s screen checks do.
    async fn answer(
        path: &str,
        mode: Option<corten::Mode>,
    ) -> (corten::http::StatusCode, bool, String) {
        crate::config::load_env();
        let shared = crate::app::Shared {
            db: Database::connect_lazy(&crate::config::database_url()),
            slab_providers: crate::features::slab_connections::Transport::default(),
        };
        let client = crate::app::app(shared).test();
        let mut call = client.get(&corten::Local::parse(path).unwrap());
        if let Some(mode) = mode {
            call = call.mode(mode);
        }
        let answer = call.await;
        let patched = answer.headers().contains_key("corten-patch");
        (answer.status(), patched, answer.text().to_owned())
    }

    /// A scope chosen with JavaScript answers the selling history for it alone: no layout, no
    /// other part, no stream.
    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn a_scope_change_with_javascript_is_the_selling_history_alone() {
        let (status, patched, body) = answer(
            "/inventory-strategy?history_days=365&history_product_line=",
            Some(corten::Mode::Action),
        )
        .await;
        assert!(status.is_success() && patched, "{status}: {body}");
        assert!(
            body.starts_with(r#"<div id="selling-history-part""#),
            "{body}"
        );
        assert!(body.contains(r#"<option value="365" selected>"#), "{body}");
        for other in [
            "<main",
            "<corten-live",
            "Realized performance",
            "Capital turnaround",
        ] {
            assert!(!body.contains(other), "{other}: {body}");
        }
    }

    /// The page waits for its slow parts' streams, each with a link to the page that reads them
    /// in; that page (`?whole=true`) has every part and no stream, and a scope's own address
    /// reads the selling history in and leaves the rest to their stream.
    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn the_query_field_reads_the_slow_parts_in() {
        let panels = [
            ">Realized performance<",
            ">Capital turnaround<",
            ">Selling history<",
            ">Hurdle sweep<",
        ];
        let (status, _, first) = answer("/inventory-strategy", None).await;
        assert!(status.is_success(), "{status}: {first}");
        for src in [
            "/inventory-strategy/returns/live",
            "/inventory-strategy/selling-history/live",
        ] {
            assert!(
                first.contains(&format!(r#"<corten-live src="{src}">"#)),
                "{src}: {first}"
            );
        }
        assert_eq!(
            first
                .matches(r#"href="/inventory-strategy?whole=true""#)
                .count(),
            4
        );
        assert!(!first.contains(r#"name="history_days""#), "{first}");

        let (status, _, whole) = answer("/inventory-strategy?whole=true", None).await;
        assert!(status.is_success(), "{status}: {whole}");
        assert!(
            !whole.contains("<corten-live") && !whole.contains("strategy-screen__reading"),
            "{whole}"
        );
        for panel in panels {
            assert!(whole.contains(panel), "{panel}: {whole}");
        }

        let (status, _, scoped) = answer(
            "/inventory-strategy?history_days=90&history_product_line=",
            None,
        )
        .await;
        assert!(status.is_success(), "{status}: {scoped}");
        assert!(
            scoped.contains(r#"<option value="90" selected>"#),
            "{scoped}"
        );
        assert!(
            scoped.contains(
                r#"<corten-live src="/inventory-strategy/returns/live?history_days=90">"#
            ),
            "{scoped}"
        );
        assert!(!scoped.contains("/selling-history/live"), "{scoped}");
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
