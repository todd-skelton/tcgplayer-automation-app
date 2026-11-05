//! The Product Price Matrix's views. Each component's stylesheet and script are next to it in
//! `views/`.
use corten::Component;

mod matrix_screen;
mod matrix_table;
mod refund_helper;

pub use matrix_screen::MatrixScreen;
pub use matrix_table::MatrixTable;
pub use refund_helper::{PricedCondition, RefundHelper};

pub const COMPONENTS: &[Component] = &[MatrixScreen, MatrixTable, RefundHelper, PricedCondition];
