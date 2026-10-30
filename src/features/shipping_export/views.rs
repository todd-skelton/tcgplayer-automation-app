//! The Shipping Workflow's views. Each component's stylesheet and script are next to it in
//! `views/`.
use corten::Component;

mod buy_postage_step;
mod load_orders_step;
mod print_step;
mod pull_sheet_step;
mod sale_value_figures;
mod shipment_editor;
mod shipping_workflow_screen;

pub use buy_postage_step::{BuyPostageStep, PostageRow};
pub use load_orders_step::{LoadOrdersStep, Loading};
pub use print_step::{LabelSheet, PrintStep};
pub use pull_sheet_step::{PullSheetStep, Pulled};
pub use sale_value_figures::SaleValueFigures;
pub use shipment_editor::{ShipmentEditor, ShipmentEditorForm};
pub use shipping_workflow_screen::{BuyAllAction, ShippingWorkflowScreen, StepBar};

pub const COMPONENTS: &[Component] = &[
    ShippingWorkflowScreen,
    LoadOrdersStep,
    SaleValueFigures,
    BuyPostageStep,
    ShipmentEditor,
    PrintStep,
];
