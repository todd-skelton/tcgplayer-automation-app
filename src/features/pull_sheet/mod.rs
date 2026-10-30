//! Pull Sheet: upload a TCGplayer pull sheet CSV and see every card to pull, as picture cards or
//! a table, filtered and sorted in the browser. Ported from `app/features/pull-sheet`.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /pull-sheet` | the upload form and the recent sheets |
//! | `POST /pull-sheet` | the sheet saved and the browser sent to it, or the form with why the file is not a pull sheet |
//! | `GET /pull-sheet/{id}` | the sheet: `q` filters it and `sort` orders it without JavaScript |
mod items;
mod page;
mod sheet;
mod store;
mod views;

pub use items::Item;
pub use page::shown;
pub use views::COMPONENTS;
pub use views::{ItemCard, Paging, SheetItems, SortBy, Summary};

/// A pull sheet's items, each with what the catalog knows of its SKU, and the orders it was made
/// for; or why the text is not a pull sheet.
pub async fn read(
    db: &crate::database::Database,
    text: &str,
) -> Result<(Vec<Item>, Vec<String>), String> {
    let parsed = sheet::parse(text).map_err(|e| e.to_string())?;
    let skus = items::find_skus(db, &parsed.rows)
        .await
        .map_err(|e| e.to_string())?;
    Ok((items::items(parsed.rows, &skus), parsed.order_ids))
}

// Handlers are named from here, where the routes module is declared.
use page::{show, upload, upload_page};

#[corten::routes(area = PullSheets, state = crate::app::Shared)]
pub mod url {
    #[route("/pull-sheet", get = upload_page, post = upload)]
    pub struct PullSheets;

    #[route("/pull-sheet/{id}", get = show)]
    pub struct PullSheet {
        pub id: i64,
        #[route(query)]
        pub filters: SheetQuery,
    }

    /// What the sheet shows without JavaScript: the rows matching `q`, in `sort`'s order. With
    /// JavaScript the browser filters and sorts the rows it has, and these only start it off.
    #[derive(Clone, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct SheetQuery {
        pub q: Option<String>,
        pub sort: Option<super::views::SortBy>,
    }
}
