//! The Configuration screen. Its stylesheet and script are next to it in `views/`.
use corten::Component;

mod configuration_screen;
mod report_panels;

pub use configuration_screen::{
    ConfigurationScreen, Lines, PricingForm, ProductLinesSection, Section, SnapsForm, SupplyForm,
};
pub use report_panels::{
    CalibrationPanel, OnPage, Report, ReportPanels, Reports, ShippingReportPanel,
};

/// `ConfigurationScreen` holds the stylesheet its sections share, `ReportPanels` the reports'.
pub const COMPONENTS: &[Component] = &[ConfigurationScreen, ReportPanels];
