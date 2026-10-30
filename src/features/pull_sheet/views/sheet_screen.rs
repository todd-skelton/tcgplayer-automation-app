use corten::{Href, prelude::*};

use super::{Paging, SheetItems, SortBy, Summary};
use crate::{
    features::pull_sheet::{
        items::Item,
        url::{self, SheetQuery},
    },
    text::Msg,
    theme::*,
};

/// An uploaded sheet: its file, its summary, and its items to filter and sort.
#[component]
pub fn SheetScreen<'a>(
    id: i64,
    file_name: &'a str,
    summary: &'a Summary,
    items: &'a [Item],
    filters: &'a SheetQuery,
    t: Msg,
) -> impl Render {
    let at = move |sort: Option<SortBy>| {
        url::PullSheet {
            id,
            filters: SheetQuery {
                q: sort.and(filters.q.clone()),
                sort,
            },
        }
        .with_href(str::to_owned)
    };
    html! {
        let link = |by| at(Some(by));
        let paging = Paging { action: at(None), keep: Vec::new(), filters, link: &link };
        <section>
            <h1>"Pull Sheet"</h1>
            <SheetItems
                items={items}
                summary={summary}
                lead={&html! {
                    <span class={muted()}>{file_name}</span>
                    <a href={url::PullSheets}>"Upload another"</a>
                }}
                paging={&paging}
                detail={None}
                t={t}
            />
        </section>
    }
}
