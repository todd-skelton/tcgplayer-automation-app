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

pub use views::COMPONENTS;
/// For the test that writes the scripts' types.
#[cfg(test)]
pub use views::SortBy;

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
