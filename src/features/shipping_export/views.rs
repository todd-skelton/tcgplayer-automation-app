//! The Shipping Workflow's views. Each component's stylesheet and script are next to it in
//! `views/`.
use corten::Component;

mod buy_postage_step;
mod label_management;
mod load_orders_step;
mod pack_step;
mod print_step;
mod pull_sheet_step;
mod sale_value_figures;
mod ship_step;
mod shipment_editor;
mod shipping_workflow_screen;

pub use buy_postage_step::{BuyPostageStep, PostageRow};
pub use label_management::{LabelForm, LabelManagement, Looked};
pub use load_orders_step::{LoadOrdersStep, Loading};
pub use pack_step::{PackCard, PackRow, PackStep, PackedOrder, Packing, ShipmentToPack};
pub use print_step::{LabelSheet, PrintStep};
pub use pull_sheet_step::{PullSheetStep, Pulled};
pub use sale_value_figures::SaleValueFigures;
pub use ship_step::{ShipStep, Shipping};
pub use shipment_editor::{ShipmentEditor, ShipmentEditorForm};
pub use shipping_workflow_screen::{
    BuyAllAction, Refused, ShipAction, ShippingWorkflowScreen, StepBar,
};

pub const COMPONENTS: &[Component] = &[
    ShippingWorkflowScreen,
    LoadOrdersStep,
    SaleValueFigures,
    BuyPostageStep,
    ShipmentEditor,
    PrintStep,
    PackStep,
    ShipmentToPack,
    ShipStep,
    LabelManagement,
    LabelForm,
];
