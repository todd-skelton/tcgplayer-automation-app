//! The window a report on the configuration screen is read over: how listings sold against their
//! sell-time forecasts (`features::forecast_calibration`), and what shipping costs at each
//! threshold and what snapping did (`features::shipping_thresholds::report`).
use serde::Deserialize;

/// The days a report is read over, as its window select and links write it. None is the
/// report's default: 56 for the calibration, the snaps' evidence window for shipping.
#[derive(Clone, Copy, Debug, Default, Deserialize, corten::Route, corten::Fields)]
#[route(query)]
pub struct Window {
    pub days: Option<u32>,
}

impl Window {
    /// The days asked for when they are one of `windows`, else `default`: the Node routes refuse
    /// any other.
    pub fn days_in(self, windows: &[u32], default: u32) -> u32 {
        self.days
            .filter(|days| windows.contains(days))
            .unwrap_or(default)
    }
}
