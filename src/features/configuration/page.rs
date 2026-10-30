use std::time::Duration;

use corten::{LiveResponse, UrlValue, prelude::*};
use futures_util::stream;
use serde::Deserialize;

use super::{
    config::{self, Config},
    form::{AddLineInput, DefaultPercentileInput, PricingInput, SnapsInput, SupplyInput},
    reports::{
        self, CALIBRATION_WINDOWS, Calibration, DEFAULT_CALIBRATION_WINDOW, Shipping, Window,
    },
    url,
    views::{
        CalibrationPanel, ConfigurationScreen, Lines, OnPage, PricingForm, ProductLinesSection,
        Report, Reports, Section, ShippingReportPanel, SnapsForm, SupplyForm,
    },
};
use crate::{
    database::Database,
    features::configuration::config::EVIDENCE_WINDOWS,
    layout::{Chrome, Layout},
    legacy::Legacy,
};

/// What the post before the page did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Done {
    Reset,
}

/// Every product line, by name: the picker's choices and the table's names.
async fn product_lines(db: &Database) -> sqlx::Result<Vec<(i32, String)>> {
    sqlx::query_as(
        "SELECT product_line_id, product_line_name FROM product_lines ORDER BY product_line_name",
    )
    .fetch_all(&db.0)
    .await
}

/// The section a post answered, with what it showed; the others as stored.
#[derive(Default)]
struct Answered {
    pricing: Option<(PricingInput, Errors)>,
    default: Option<(DefaultPercentileInput, Errors)>,
    add: Option<(AddLineInput, Errors)>,
    snaps: Option<(SnapsInput, Errors)>,
    supply: bool,
    said: Option<&'static str>,
    /// A report read for this request: its own route, reached without scripts.
    calibration: Option<(u32, Result<Calibration, String>)>,
    shipping: Option<(u32, Result<Shipping, String>)>,
}

async fn page(req: &Req, db: &Database, done: Option<Done>, answered: Answered) -> HtmlResult {
    let config = config::load(db).await?;
    let names = product_lines(db).await?;
    let chrome = Chrome::read(db).await;
    let none = Errors::new();
    let pricing = answered
        .pricing
        .unwrap_or_else(|| (PricingInput::of(&config.pricing), Errors::new()));
    let snaps = answered
        .snaps
        .unwrap_or_else(|| (SnapsInput::of(&config.snaps), Errors::new()));
    let default = answered
        .default
        .unwrap_or_else(|| (default_input(&config), Errors::new()));
    let add = answered.add.unwrap_or_default();
    let line_errors = if add.1.is_empty() { &default.1 } else { &add.1 };
    let supply = SupplyInput::of(&config.supply);
    let reports = Reports {
        calibration: on_page(&answered.calibration),
        shipping: on_page(&answered.shipping),
        evidence_days: config.snaps.evidence_window_days,
        hurdle: hurdle(&config),
    };
    req.page(html! {
        <Layout req={req} title="Configuration" chrome={chrome} head="">
            <ConfigurationScreen
                auth_cookie_missing={chrome.auth_cookie_missing}
                reset={done == Some(Done::Reset)}
                pricing={Section { input: &pricing.0, errors: &pricing.1, saved: false }}
                lines={lines(&config, &names, &default.0, &add.0, line_errors, answered.said)}
                snaps={Section { input: &snaps.0, errors: &snaps.1, saved: false }}
                reports={&reports}
                supply={Section { input: &supply, errors: &none, saved: answered.supply }}
            />
        </Layout>
    })
}

/// A report read for this request, or the stream's to send.
fn on_page<T>(read: &Option<(u32, Result<T, String>)>) -> OnPage<'_, T> {
    match read {
        Some((days, report)) => OnPage::Read(*days, report),
        None => OnPage::Streamed,
    }
}

/// The daily return hurdle the calibration report weighs, when the profit-per-day policy uses one.
fn hurdle(config: &Config) -> Option<f64> {
    (config.pricing.policy == config::Policy::ProfitPerDay)
        .then_some(config.pricing.profit_per_day.daily_return_hurdle)
}

fn default_input(config: &Config) -> DefaultPercentileInput {
    DefaultPercentileInput {
        default_percentile: config.product_lines.default_percentile.to_string(),
    }
}

fn lines<'a>(
    config: &'a Config,
    names: &'a [(i32, String)],
    default: &'a DefaultPercentileInput,
    add: &'a AddLineInput,
    errors: &'a Errors,
    said: Option<&'a str>,
) -> Lines<'a> {
    Lines {
        stored: &config.product_lines,
        names,
        default,
        add,
        errors,
        said,
        default_hurdle: config.pricing.profit_per_day.daily_return_hurdle,
        percentiles: (config.pricing.min_percentile, config.pricing.max_percentile),
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::Configuration>,
) -> HtmlResult {
    page(&req, &db, at.done, Answered::default()).await
}

/// The page again, without scripts: a post's own answer is the section it saved.
fn back(req: &Req) -> HtmlResult {
    req.redirect(&url::Configuration { done: None })
}

pub async fn save_pricing(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<PricingInput>,
) -> HtmlResult {
    let stored = config::load(&db).await?;
    let (pricing, errors) = input.read(&stored.pricing);
    config::save_pricing(&db, &pricing).await?;
    if errors.is_empty() {
        let shown = PricingInput::of(&pricing);
        let form = PricingForm {
            section: &Section {
                input: &shown,
                errors: &errors,
                saved: true,
            },
        };
        return req.patch_or(form, || async { back(&req) }).await;
    }
    let form = PricingForm {
        section: &Section {
            input: &input,
            errors: &errors,
            saved: false,
        },
    };
    let answered = Answered {
        pricing: Some((input.clone(), errors.clone())),
        ..Answered::default()
    };
    req.invalid(&errors, form, || page(&req, &db, None, answered))
        .await
}

pub async fn save_snaps(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SnapsInput>,
) -> HtmlResult {
    let stored = config::load(&db).await?;
    let (snaps, errors) = input.read(&stored.snaps);
    config::save_snaps(&db, &snaps).await?;
    if errors.is_empty() {
        let shown = SnapsInput::of(&snaps);
        let form = SnapsForm {
            section: &Section {
                input: &shown,
                errors: &errors,
                saved: true,
            },
        };
        // The report weighs the snaps, so it is read again, over their evidence window.
        let days = snaps.evidence_window_days;
        let again = url::ShippingReport {
            window: Window { days: Some(days) },
        };
        let patch = html! {
            {form}
            <ShippingReportPanel days={days} report={Report::Waiting} />
            {ReadAgain { after: Duration::from_secs(1) }.from(&again)}
        };
        return req.patch_or(patch, || async { back(&req) }).await;
    }
    let form = SnapsForm {
        section: &Section {
            input: &input,
            errors: &errors,
            saved: false,
        },
    };
    let answered = Answered {
        snaps: Some((input.clone(), errors.clone())),
        ..Answered::default()
    };
    req.invalid(&errors, form, || page(&req, &db, None, answered))
        .await
}

pub async fn save_supply(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<SupplyInput>,
) -> HtmlResult {
    config::save_supply(&db, &input.read()).await?;
    let none = Errors::new();
    let form = SupplyForm {
        section: &Section {
            input: &input,
            errors: &none,
            saved: true,
        },
    };
    req.patch_or(form, || async { back(&req) }).await
}

/// Answers the product line section, or the page without scripts.
async fn answer_lines(req: &Req, db: &Database, answered: Answered) -> HtmlResult {
    let config = config::load(db).await?;
    let names = product_lines(db).await?;
    let default = answered
        .default
        .unwrap_or_else(|| (default_input(&config), Errors::new()));
    let add = answered.add.unwrap_or_default();
    let errors = if add.1.is_empty() { &default.1 } else { &add.1 };
    let shown = lines(&config, &names, &default.0, &add.0, errors, answered.said);
    let section = ProductLinesSection { lines: &shown };
    if errors.is_empty() {
        req.patch_or(section, || async { back(req) }).await
    } else {
        let answered = Answered {
            default: Some(default.clone()),
            add: Some(add.clone()),
            ..Answered::default()
        };
        req.invalid(errors, section, || page(req, db, None, answered))
            .await
    }
}

pub async fn save_default(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<DefaultPercentileInput>,
) -> HtmlResult {
    let stored = config::load(&db).await?;
    let (percentile, errors) = input.read(stored.product_lines.default_percentile);
    if errors.is_empty() {
        config::save_default_percentile(&db, percentile).await?;
        let said = Some("Default percentile updated");
        return answer_lines(
            &req,
            &db,
            Answered {
                said,
                ..Answered::default()
            },
        )
        .await;
    }
    answer_lines(
        &req,
        &db,
        Answered {
            default: Some((input, errors)),
            ..Answered::default()
        },
    )
    .await
}

pub async fn add_line(
    req: Req,
    State(db): State<Database>,
    Form(input): Form<AddLineInput>,
) -> HtmlResult {
    let stored = config::load(&db).await?;
    let names = product_lines(&db).await?;
    let configurable = |id: i32| {
        names.iter().any(|(line, _)| *line == id)
            && !stored.product_lines.settings.contains_key(&id)
    };
    match input.read(stored.product_lines.default_percentile, configurable) {
        Ok((id, setting)) => {
            config::set_line(&db, id, &setting).await?;
            let said = Some("Product line pricing added");
            answer_lines(
                &req,
                &db,
                Answered {
                    said,
                    ..Answered::default()
                },
            )
            .await
        }
        Err(errors) => {
            answer_lines(
                &req,
                &db,
                Answered {
                    add: Some((input, errors)),
                    ..Answered::default()
                },
            )
            .await
        }
    }
}

pub async fn remove_line(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::RemoveProductLine>,
) -> HtmlResult {
    config::remove_line(&db, at.id).await?;
    let said = Some("Product line pricing removed");
    answer_lines(
        &req,
        &db,
        Answered {
            said,
            ..Answered::default()
        },
    )
    .await
}

pub async fn reset(req: Req, State(db): State<Database>) -> HtmlResult {
    config::reset(&db).await?;
    req.redirect(&url::Configuration {
        done: Some(Done::Reset),
    })
}

/// The calibration panel read over the window asked for; the page with it without scripts.
pub async fn calibration_report(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::CalibrationReport>,
) -> HtmlResult {
    let days = at
        .window
        .days_in(&CALIBRATION_WINDOWS, DEFAULT_CALIBRATION_WINDOW);
    let (config, report) = tokio::join!(config::load(&db), reports::calibration(&legacy, days));
    let panel = CalibrationPanel {
        days,
        report: Report::Read(&report),
        hurdle: hurdle(&config?),
    };
    let answered = || Answered {
        calibration: Some((days, report.clone())),
        ..Answered::default()
    };
    req.patch_or(panel, || page(&req, &db, None, answered()))
        .await
}

/// The shipping report panel read over the window asked for; the page with it without scripts.
pub async fn shipping_report(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::ShippingReport>,
) -> HtmlResult {
    let evidence = config::load(&db).await?.snaps.evidence_window_days;
    let days = at.window.days_in(&EVIDENCE_WINDOWS, evidence);
    let report = reports::shipping(&legacy, days).await;
    let panel = ShippingReportPanel {
        days,
        report: Report::Read(&report),
    };
    let answered = || Answered {
        shipping: Some((days, report.clone())),
        ..Answered::default()
    };
    req.patch_or(panel, || page(&req, &db, None, answered()))
        .await
}

/// The calibration panel once read over its default window, for the page's `<corten-live>`.
pub async fn calibration_live(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
) -> LiveResponse {
    corten::live(stream::once(async move {
        let days = DEFAULT_CALIBRATION_WINDOW;
        let (config, report) = tokio::join!(config::load(&db), reports::calibration(&legacy, days));
        let hurdle = config.ok().as_ref().and_then(hurdle);
        CalibrationPanel {
            days,
            report: Report::Read(&report),
            hurdle,
        }
        .to_html()
    }))
}

/// The shipping report panel once read over the snaps' evidence window, for the page's
/// `<corten-live>`.
pub async fn shipping_live(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
) -> LiveResponse {
    corten::live(stream::once(async move {
        let report = match config::load(&db).await {
            Ok(config) => {
                let days = config.snaps.evidence_window_days;
                (days, reports::shipping(&legacy, days).await)
            }
            Err(_) => {
                let days = config::Snaps::default().evidence_window_days;
                (days, Err("The configuration could not be read.".to_owned()))
            }
        };
        ShippingReportPanel {
            days: report.0,
            report: Report::Read(&report.1),
        }
        .to_html()
    }))
}
