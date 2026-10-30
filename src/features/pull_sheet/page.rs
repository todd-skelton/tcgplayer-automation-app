use corten::prelude::*;
use serde::Deserialize;

use super::{
    items::{self, Item},
    sheet, store, url,
    views::{SheetScreen, SortBy, Summary, UploadForm, UploadScreen},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    text::Msg,
};

/// The largest sheet the screen takes; TCGplayer's run to a few hundred KB.
const MOST: usize = 20 << 20;

#[derive(Deserialize, Fields)]
pub struct UploadInput {
    pub file: Files,
}

pub async fn upload_page(req: Req, State(db): State<Database>) -> HtmlResult {
    upload_screen(&req, &db, &Errors::new()).await
}

async fn upload_screen(req: &Req, db: &Database, errors: &Errors) -> HtmlResult {
    let (chrome, recent) = tokio::join!(Chrome::read(db), store::recent(db));
    let recent = recent?;
    req.page(html! {
        <Layout req={req} title="Pull Sheet" chrome={chrome} head="">
            <UploadScreen recent={&recent} errors={errors} />
        </Layout>
    })
}

/// Saves the sheet and sends the browser to it; a file that is not a pull sheet gets the form
/// back with why.
pub async fn upload(
    req: Req,
    State(db): State<Database>,
    mut upload: Upload<UploadInput>,
) -> HtmlResult {
    let f = UploadInput::FIELDS;
    upload.limit(MOST + (64 << 10));
    let mut errors = Errors::new();
    let mut chosen = None;
    while let Some(mut file) = upload.next_file().await? {
        if file.is(f.file) {
            let name = file.filename().to_string();
            match file.bytes_up_to(MOST).await? {
                Some(bytes) => chosen = Some((name, bytes)),
                None => errors.add(f.file, "A pull sheet can be up to 20 MB."),
            }
        }
    }
    upload.fields().await?;
    let text = match &chosen {
        Some((_, bytes)) => String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string(),
        None => String::new(),
    };
    // A file over the limit already says why; otherwise say what is wrong with the one sent.
    if errors.is_empty() && chosen.is_none() {
        errors.add(f.file, "Choose a pull sheet CSV.");
    } else if errors.is_empty()
        && let Err(why) = sheet::parse(&text)
    {
        errors.add(f.file, format!("Failed to process file: {why}"));
    }
    if !errors.is_empty() {
        return req
            .invalid(&errors, UploadForm { errors: &errors }, || {
                upload_screen(&req, &db, &errors)
            })
            .await;
    }
    let name = chosen.map(|(name, _)| name).unwrap_or_default();
    let id = store::save(&db, &name, &text).await?;
    req.redirect(&url::PullSheet {
        id,
        filters: url::SheetQuery::default(),
    })
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::PullSheet>,
) -> HtmlResult {
    let (chrome, stored) = tokio::join!(Chrome::read(&db), store::find(&db, at.id));
    let stored = stored?.ok_or_else(corten::Error::not_found)?;
    let parsed = sheet::parse(&stored.csv_text).map_err(|e| corten::Error::new(e.to_string()))?;
    let skus = items::find_skus(&db, &parsed.rows).await?;
    let mut all = items::items(parsed.rows, &skus);
    let summary = Summary::of(&all, parsed.order_ids.len());
    if let Some(q) = at
        .filters
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    {
        let q = q.to_lowercase();
        all.retain(|item| item.search_text().contains(&q));
    }
    if let Some(by) = at.filters.sort {
        sort(&mut all, by);
    }
    let t: Msg = req.t();
    let file_name = stored.file_name.as_str();
    req.page(html! {
        <Layout req={&req} title={file_name} chrome={chrome} head="">
            <SheetScreen
                id={stored.pull_sheet_id}
                file_name={file_name}
                summary={&summary}
                items={&all}
                filters={&at.filters}
                t={t}
            />
        </Layout>
    })
}

/// The order the table's column links ask for, as the browser sorts it with JavaScript.
fn sort(items: &mut [Item], by: SortBy) {
    match by {
        SortBy::Product => items.sort_by_key(|i| i.display_name().to_lowercase()),
        SortBy::Number => items.sort_by(|a, b| a.number.cmp(&b.number)),
        SortBy::Set => items.sort_by(|a, b| a.set.cmp(&b.set)),
        SortBy::Condition => items.sort_by(|a, b| a.shown_condition().cmp(b.shown_condition())),
        SortBy::Rarity => items.sort_by(|a, b| a.rarity.cmp(&b.rarity)),
        SortBy::Quantity => items.sort_by_key(|i| i.quantity),
        SortBy::ProductLine => items.sort_by(|a, b| a.product_line.cmp(&b.product_line)),
    }
}
