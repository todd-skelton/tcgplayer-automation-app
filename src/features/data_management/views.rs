//! The Data Management screen. Its stylesheet is next to it in `views/`.
use corten::Component;

mod data_screen;

pub use data_screen::{DataScreen, JobCard};

pub const COMPONENTS: &[Component] = &[DataScreen];
