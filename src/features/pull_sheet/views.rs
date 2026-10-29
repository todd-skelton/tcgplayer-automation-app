//! The Pull Sheet screens. Each component's script and stylesheet are next to it in `views/`.
use corten::{Component, ToJson, UrlValue};
use serde::Deserialize;

mod item_card;
mod item_row;
mod sheet_screen;
mod upload_screen;

pub use item_card::ItemCard;
pub use item_row::ItemRow;
pub use sheet_screen::{SheetScreen, Summary};
pub use upload_screen::{UploadForm, UploadScreen};

pub const COMPONENTS: &[Component] = &[UploadScreen, SheetScreen, ItemCard, ItemRow];

/// A column the table sorts by: the browser sorts with JavaScript (the handler takes it as
/// JSON), the server from `?sort=`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, ToJson, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SortBy {
    Product,
    Number,
    Set,
    Condition,
    Rarity,
    Quantity,
    ProductLine,
}

/// TCGplayer's picture of a product, `size` like `400x400`.
pub fn picture(product_id: i32, size: &str) -> String {
    format!("https://tcgplayer-cdn.tcgplayer.com/product/{product_id}_in_{size}.jpg")
}
