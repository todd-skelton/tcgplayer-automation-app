use corten::prelude::*;

use super::super::{page::UploadInput, store::RecentSheet, url};
use crate::{
    theme::*,
    ui::button::{Button, ButtonSize, ButtonVariant},
    ui::card::{CardCompact, CardPanel},
};

/// The upload form's id: a refused file's answer replaces it.
#[derive(Id)]
pub struct UploadFormId;

/// Where a sheet comes from: the upload form, and the sheets uploaded lately.
#[component(css)]
pub fn UploadScreen<'a>(recent: &'a [RecentSheet], errors: &'a Errors) -> impl Render {
    html! {
        <h1>"Pull Sheet"</h1>
        <div class={(CardPanel {}, CardCompact {}, mb_5())}>
            <UploadForm errors={errors} />
        </div>
        if recent.is_empty() {
            <div class={Empty}>
                <h2>"Upload a TCGPlayer pull sheet CSV to get started"</h2>
                <p class={muted()}>
                    "The pull sheet will display all items with condition and print indicators to help you pull the correct cards."
                </p>
            </div>
        } else {
            <section class={(CardPanel {}, CardCompact {})}>
                <h2 class={mb_3()}>"Recent pull sheets"</h2>
                <ul class={Recent}>
                    for sheet in recent {
                        <li>
                            <a
                                href={url::PullSheet { id: sheet.pull_sheet_id, filters: url::SheetQuery::default() }}
                            >
                                {&sheet.file_name}
                            </a>
                            " "
                            <time datetime={sheet.uploaded_at.to_rfc3339()} class={muted()}>
                                {sheet.uploaded_at.format("%b %-d, %Y %H:%M UTC").to_string()}
                            </time>
                        </li>
                    }
                </ul>
            </section>
        }
    }
}

/// The file input and its error. With JavaScript a refused file swaps in this form with its
/// message; without, the whole page comes back.
#[component]
pub fn UploadForm<'a>(errors: &'a Errors) -> impl Patch {
    let (f, e) = (UploadInput::FIELDS, errors.within(UploadFormId));
    html! {
        <form
            id={UploadFormId}
            method="post"
            action={url::PullSheets}
            enctype="multipart/form-data"
            data-patch
        >
            <div class={row(Space::_3)}>
                <label>
                    "Pull sheet CSV "
                    <input
                        type="file"
                        name={f.file}
                        accept=".csv,text/csv"
                        required
                        {..e.aria(f.file)}
                    >
                </label>
                <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                    "Upload Pull Sheet CSV"
                </button>
            </div>
            {e.message(f.file)}
        </form>
    }
}
