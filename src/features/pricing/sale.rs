//! A sale as TCGplayer's latest-sales API reports it, the evidence the pricer reads.
use chrono::DateTime;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sale {
    pub condition: String,
    pub variant: String,
    pub language: String,
    pub quantity: f64,
    pub title: String,
    pub listing_type: String,
    pub custom_listing_id: String,
    /// Per card.
    pub purchase_price: f64,
    /// Per order.
    pub shipping_price: f64,
    pub order_date: String,
}

impl Sale {
    /// `new Date(orderDate).getTime()`: epoch milliseconds, or NaN for a date it cannot read.
    pub fn timestamp(&self) -> f64 {
        DateTime::parse_from_rfc3339(&self.order_date)
            .map_or(f64::NAN, |t| t.timestamp_millis() as f64)
    }

    /// The per-card value pricing reads.
    pub fn effective_price(&self) -> f64 {
        super::effective_sale_price::effective_sale_price(
            Some(self.purchase_price),
            Some(self.shipping_price),
            Some(self.quantity),
        )
    }
}
