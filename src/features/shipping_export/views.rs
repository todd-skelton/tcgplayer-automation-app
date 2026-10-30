//! The Shipping Workflow's views. Each component's stylesheet and script are next to it in
//! `views/`.
use corten::Component;

mod load_orders_step;
mod pull_sheet_step;
mod sale_value_figures;
mod shipping_workflow_screen;

pub use load_orders_step::{LoadOrdersStep, Loading};
pub use pull_sheet_step::{PullSheetStep, Pulled};
pub use sale_value_figures::SaleValueFigures;
pub use shipping_workflow_screen::{ShippingWorkflowScreen, StepBar};

pub const COMPONENTS: &[Component] = &[ShippingWorkflowScreen, LoadOrdersStep, SaleValueFigures];
