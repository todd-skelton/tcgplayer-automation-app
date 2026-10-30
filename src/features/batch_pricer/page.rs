use std::{
    hash::{DefaultHasher, Hash, Hasher},
    time::{Duration, SystemTime},
};

use corten::{
    ClientZone, Fragment, LiveResponse, LiveSince, Media, Mode, axum::http::StatusCode, prelude::*,
};
use corten_ui::Toast;
use futures_util::stream;
use serde::Deserialize;

use super::{
    batches::{self, Batch, Mode as Pricing, Publications},
    url,
    views::{BatchFollow, BatchPanel, BatchProblem, CsvForm, PricerScreen, SellerForm},
};
use crate::{
    database::Database,
    features::{configuration, shipping_configuration},
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// How often a batch that prices or publishes is read again, as the React screen's stream read it.
const FOLLOW_EVERY: Duration = Duration::from_secs(1);
/// How often a browser without JavaScript reads the page again while the batch prices or
/// publishes.
const RELOAD_EVERY: Duration = Duration::from_secs(5);
/// Reads in a row that fail before a follow gives up (the batch was deleted, the Node app went).
const MOST_FAILURES: u32 = 10;
/// The largest CSV export the screen takes.
const MOST: usize = 20 << 20;

impl url::BatchPricer {
    pub fn newest() -> Self {
        url::BatchPricer {
            chosen: Chosen::default(),
            deleted: None,
        }
    }

    pub fn batch(batch: i32) -> Self {
        url::BatchPricer {
            chosen: Chosen { batch: Some(batch) },
            deleted: None,
        }
    }
}

/// Which batch the screen shows, as its picker and links write it: none is the newest.
#[derive(Clone, Copy, Debug, Default, Deserialize, corten::Route, corten::Fields)]
#[route(query)]
pub struct Chosen {
    pub batch: Option<i32>,
}

/// The success rates under which a batch's summary suggests repricing its errors, and over which
/// it says the batch is in good shape.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SuccessRates {
    pub low: f64,
    pub high: f64,
}

async fn success_rates(db: &Database) -> sqlx::Result<SuccessRates> {
    let (low, high) = configuration::success_rate_thresholds(db).await?;
    Ok(SuccessRates { low, high })
}

/// A batch as its panel draws it: the batch, its publications or why they could not be read, and
/// the success rates its summary is judged by.
pub struct Shown {
    pub batch: Batch,
    pub publications: Result<Publications, String>,
    pub rates: SuccessRates,
}

impl Shown {
    async fn read(legacy: &Legacy, batch: i32, rates: SuccessRates) -> Result<Shown, String> {
        let (one, publications) = tokio::join!(
            batches::one(legacy, batch),
            batches::publications(legacy, batch)
        );
        Ok(Shown {
            batch: one?,
            publications,
            rates,
        })
    }

    /// Whether it prices or publishes, so its panel changes on its own.
    pub fn following(&self) -> bool {
        self.batch.pricing() || self.publications.as_ref().is_ok_and(Publications::active)
    }

    /// What the panel draws, as the live stream's cursor: a page that shows it already is sent
    /// nothing until it changes.
    pub fn version(&self) -> String {
        let mut hasher = DefaultHasher::new();
        format!("{:?}{:?}", self.batch, self.publications).hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }
}

/// What a page is drawn with besides the batches: what the last post did, why it was refused, and
/// a new batch's form as sent with its errors.
#[derive(Default)]
struct Drawn<'a> {
    notice: Option<&'a str>,
    problem: Option<&'a str>,
    errors: Option<&'a Errors>,
    seller: Option<&'a str>,
}

/// The Node app could not list or read the batches: the screen has nothing to draw.
fn unavailable(message: String) -> corten::Error {
    corten::Error::new(message).with_status(StatusCode::BAD_GATEWAY)
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::BatchPricer>,
) -> HtmlResult {
    let notice = at.deleted.map(|batch| format!("Batch {batch} deleted"));
    let drawn = Drawn {
        notice: notice.as_deref(),
        ..Drawn::default()
    };
    page(
        &req,
        &db,
        &legacy,
        at.chosen.batch,
        Visitor::of(zone.as_ref()),
        &drawn,
    )
    .await
}

/// The screen with `chosen`, or the newest batch, shown.
async fn page(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    chosen: Option<i32>,
    visitor: Visitor,
    drawn: &Drawn<'_>,
) -> HtmlResult {
    let (chrome, list, seller, rates) = tokio::join!(
        Chrome::read(db),
        batches::list(legacy),
        shipping_configuration::default_seller_key(db),
        success_rates(db)
    );
    let (list, rates) = (list.map_err(unavailable)?, rates?);
    let number = chosen.or_else(|| list.first().map(|b| b.batch_number));
    let shown = match number {
        Some(n) => Some(Shown::read(legacy, n, rates).await),
        None => None,
    };
    let again = shown
        .as_ref()
        .and_then(|s| s.as_ref().ok())
        .filter(|s| s.following())
        .map(|_| {
            ReadAgain {
                after: RELOAD_EVERY,
            }
            .without_javascript()
        });
    let seller = match drawn.seller {
        Some(typed) => typed.to_owned(),
        None => seller?,
    };
    let none = Errors::new();
    req.page(html! {
        <Layout req={req} title="Batch Pricer" chrome={chrome} head={again}>
            <PricerScreen
                list={&list}
                number={number}
                shown={shown.as_ref().map(|s| s.as_ref().map_err(String::as_str))}
                seller={&seller}
                errors={drawn.errors.unwrap_or(&none)}
                notice={drawn.notice}
                problem={drawn.problem}
                t={req.t()}
                visitor={visitor}
            />
        </Layout>
    })
}

/// What a post on a batch did. With JavaScript, the batch's panel as it is now (following it
/// when it prices or publishes) and the message in a toast, or why it was refused; without, the
/// page, or the page with why.
async fn answer(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    batch: i32,
    visitor: Visitor,
    done: Result<String, String>,
) -> HtmlResult {
    if req.mode != Mode::Action {
        return match done {
            Ok(_) => req.redirect(&url::BatchPricer::batch(batch)),
            Err(message) => {
                let drawn = Drawn {
                    problem: Some(&message),
                    ..Drawn::default()
                };
                let mut page = page(req, db, legacy, Some(batch), visitor, &drawn).await?;
                *page.status_mut() = StatusCode::CONFLICT;
                Ok(page)
            }
        };
    }
    let rates = success_rates(db).await?;
    let shown = Shown::read(legacy, batch, rates)
        .await
        .map_err(unavailable)?;
    let t: Msg = req.t();
    match done {
        Ok(message) => req.patch(html! {
            <BatchFollow shown={&shown} t={t} visitor={visitor} />
            <BatchProblem message={None} />
            <Toast message={Some(message.as_str())} />
        }),
        Err(message) => req.patch_with_status(
            StatusCode::CONFLICT,
            html! {
                <BatchFollow shown={&shown} t={t} visitor={visitor} />
                <BatchProblem message={Some(message.as_str())} />
            },
        ),
    }
}

#[derive(Deserialize, Fields)]
pub struct PriceInput {
    pub mode: Pricing,
}

/// Pricing queued for every SKU of the batch or for those needing review; the Node app refuses it
/// while the batch publishes.
pub async fn price(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Price>,
    Form(input): Form<PriceInput>,
) -> HtmlResult {
    let done = batches::price(&legacy, at.batch, input.mode).await;
    answer(
        &req,
        &db,
        &legacy,
        at.batch,
        Visitor::of(zone.as_ref()),
        done,
    )
    .await
}

/// The SKUs checked in the publish dialog, each a `sku` field.
#[derive(Deserialize, Fields)]
pub struct PublishInput {
    #[serde(default)]
    pub sku: Vec<i64>,
}

/// The checked SKUs planned for publication to Seller Portal; the Node app checks each again.
pub async fn publish(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Publish>,
    Form(input): Form<PublishInput>,
) -> HtmlResult {
    let done =
        if input.sku.is_empty() {
            Err("Select at least one SKU to publish.".to_owned())
        } else {
            batches::publish(&legacy, at.batch, &input.sku).await.map(|publications| {
            format!(
                "{} SKUs from batch {} queued in {publications} Seller Portal publication{}",
                input.sku.len(),
                at.batch,
                if publications == 1 { "" } else { "s" }
            )
        })
        };
    answer(
        &req,
        &db,
        &legacy,
        at.batch,
        Visitor::of(zone.as_ref()),
        done,
    )
    .await
}

/// The batch, its items and its results deleted, and the newest batch shown; the Node app
/// refuses a batch that prices or was published.
pub async fn delete(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Delete>,
) -> HtmlResult {
    match batches::delete(&legacy, at.batch).await {
        Ok(()) => req.redirect(&url::BatchPricer {
            chosen: Chosen::default(),
            deleted: Some(at.batch),
        }),
        Err(message) => {
            answer(
                &req,
                &db,
                &legacy,
                at.batch,
                Visitor::of(zone.as_ref()),
                Err(message),
            )
            .await
        }
    }
}

/// The batch's successful or manual-review rows, as the CSV the React screen saved.
pub async fn download(
    State(legacy): State<Legacy>,
    Params(at): Params<url::Results>,
) -> corten::Result<Media> {
    let rows = batches::results(&legacy, at.batch, at.scope)
        .await
        .map_err(unavailable)?;
    if rows.is_empty() {
        return Err(corten::Error::not_found());
    }
    Ok(Media::new("text/csv; charset=utf-8", batches::csv(&rows))
        .attachment(&at.scope.file_name(at.batch)))
}

#[derive(Deserialize, Fields)]
pub struct CsvInput {
    pub file: Files,
}

/// A batch frozen from a CSV export, and the screen showing it; a file the Node app cannot read
/// gets the form back with why.
pub async fn import_csv(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    mut upload: Upload<CsvInput>,
) -> HtmlResult {
    let f = CsvInput::FIELDS;
    upload.limit(MOST + (64 << 10));
    let mut errors = Errors::new();
    let mut chosen = None;
    while let Some(mut file) = upload.next_file().await? {
        if file.is(f.file) {
            let name = file.filename().to_string();
            match file.bytes_up_to(MOST).await? {
                Some(bytes) if !bytes.is_empty() => chosen = Some((name, bytes.to_vec())),
                Some(_) => {}
                None => errors.add(f.file, "A CSV export can be up to 20 MB."),
            }
        }
    }
    upload.fields().await?;
    if let (Some((name, bytes)), true) = (chosen, errors.is_empty()) {
        match batches::import_csv(&legacy, &name, bytes).await {
            Ok(batch) => return req.redirect(&url::BatchPricer::batch(batch.batch_number)),
            Err(message) => errors.add(f.file, message),
        }
    } else if errors.is_empty() {
        errors.add(f.file, "Choose a CSV export.");
    }
    let visitor = Visitor::of(zone.as_ref());
    let drawn = Drawn {
        errors: Some(&errors),
        ..Drawn::default()
    };
    req.invalid(&errors, CsvForm { errors: &errors }, || {
        page(&req, &db, &legacy, None, visitor, &drawn)
    })
    .await
}

#[derive(Deserialize, Fields)]
pub struct SellerInput {
    pub seller_key: String,
}

/// A batch frozen from a seller's live inventory, and the screen showing it; a seller the Node
/// app cannot read gets the form back with why.
pub async fn import_seller(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Form(input): Form<SellerInput>,
) -> HtmlResult {
    let f = SellerInput::FIELDS;
    let key = input.seller_key.trim();
    let made = if key.is_empty() {
        Err("Enter a seller key.".to_owned())
    } else {
        batches::import_seller(&legacy, key).await
    };
    let message = match made {
        Ok(batch) => return req.redirect(&url::BatchPricer::batch(batch.batch_number)),
        Err(message) => message,
    };
    let mut errors = Errors::new();
    errors.add(f.seller_key, message);
    let visitor = Visitor::of(zone.as_ref());
    let drawn = Drawn {
        errors: Some(&errors),
        seller: Some(key),
        ..Drawn::default()
    };
    req.invalid(
        &errors,
        SellerForm {
            seller: key,
            errors: &errors,
        },
        || page(&req, &db, &legacy, None, visitor, &drawn),
    )
    .await
}

/// The batch's panel each time it changes while it prices or publishes, for the page's
/// `<corten-live>`; the stream ends after the panel that shows it doing neither.
pub async fn live(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    since: LiveSince,
    Params(at): Params<url::Live>,
) -> LiveResponse {
    let Ok(rates) = success_rates(&db).await else {
        return corten::live(stream::empty::<String>());
    };
    let (t, visitor): (Msg, Visitor) = (req.t(), Visitor::of(zone.as_ref()));
    let follow = Follow {
        legacy,
        batch: at.batch,
        rates,
        since: since.0,
        publications: None,
        job: None,
        reads: 0,
        failures: 0,
        ended: false,
    };
    corten::live(stream::unfold(follow, move |mut follow| async move {
        let (shown, version) = follow.next().await?;
        let html = BatchPanel {
            shown: &shown,
            t,
            visitor,
        }
        .to_html();
        Some((Fragment::new(html).cursor(version), follow))
    }))
}

/// A batch followed while it prices or publishes. Its publications are read when its pricing
/// moves on, and every other read while one publishes: theirs is the slow read.
struct Follow {
    legacy: Legacy,
    batch: i32,
    rates: SuccessRates,
    /// The version the page shows.
    since: Option<String>,
    publications: Option<Result<Publications, String>>,
    /// The latest job and when the batch was last priced, as they were when the publications
    /// were read.
    job: Option<String>,
    reads: u32,
    failures: u32,
    ended: bool,
}

impl Follow {
    /// The batch and its version, the next time it differs from what the page shows; none once
    /// the page shows it neither pricing nor publishing.
    async fn next(&mut self) -> Option<(Shown, String)> {
        while !self.ended {
            if self.reads > 0 {
                tokio::time::sleep(FOLLOW_EVERY).await;
            }
            self.reads += 1;
            let Ok(batch) = batches::one(&self.legacy, self.batch).await else {
                self.failures += 1;
                if self.failures >= MOST_FAILURES {
                    return None;
                }
                continue;
            };
            self.failures = 0;
            let job = format!(
                "{:?}{:?}",
                batch.latest_job.as_ref().map(|j| (j.id, j.status)),
                batch.last_priced_at
            );
            let publishing = matches!(&self.publications, Some(Ok(p)) if p.active());
            if self.publications.is_none()
                || self.job.as_ref() != Some(&job)
                || (publishing && self.reads.is_multiple_of(2))
            {
                self.publications = Some(batches::publications(&self.legacy, self.batch).await);
                self.job = Some(job);
            }
            let shown = Shown {
                batch,
                publications: self
                    .publications
                    .clone()
                    .unwrap_or_else(|| Err(String::new())),
                rates: self.rates,
            };
            self.ended = !shown.following();
            let version = shown.version();
            if self.since.as_ref() != Some(&version) {
                self.since = Some(version.clone());
                return Some((shown, version));
            }
        }
        None
    }
}

/// How long a pricing phase has run, as the React screen's progress wrote it: `42s`, `3m 5s`.
pub fn elapsed(started_ms: f64, now: SystemTime) -> String {
    let now_ms = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64);
    let seconds = ((now_ms - started_ms) / 1000.0).max(0.0).floor() as u64;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_runs_in_seconds_then_minutes() {
        let at = |s: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        assert_eq!(elapsed(1_000_000.0, at(1_042)), "42s");
        assert_eq!(elapsed(1_000_000.0, at(1_185)), "3m 5s");
        assert_eq!(elapsed(2_000_000.0, at(1_000)), "0s");
    }
}
