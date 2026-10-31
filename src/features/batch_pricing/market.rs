//! TCGplayer's market data for a batch's SKUs (`getPricePoints`): one POST to the gateway's price
//! point search for every SKU at once, as the Node worker asks. Not approved for dev runs yet
//! (port decision 38), so it is read only by the pricing worker, which is off unless
//! `PRICING_WORKER` turns it on.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::job::{MarketData, PricePoint};
use crate::{
    features::http_configuration::config::Domain,
    tcgplayer::{Call, TcgPlayer},
};

const PATH: &str = "/v1/pricepoints/marketprice/skus/search";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Search<'a> {
    sku_ids: &'a [i64],
}

/// One SKU's market data as the gateway answers it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    sku_id: i64,
    market_price: Option<f64>,
    lowest_price: Option<f64>,
    highest_price: Option<f64>,
    price_count: Option<f64>,
}

/// The answers by SKU. A SKU the gateway gives no market price is left out, as one it does not
/// answer for: the calculator then reads no market price for it either way.
fn by_sku(answers: Vec<Answer>) -> HashMap<i64, PricePoint> {
    answers
        .into_iter()
        .filter_map(|a| {
            Some((
                a.sku_id,
                PricePoint {
                    market_price: a.market_price?,
                    lowest_price: a.lowest_price.unwrap_or(0.0),
                    highest_price: a.highest_price.unwrap_or(0.0),
                    price_count: a.price_count.unwrap_or(0.0),
                },
            ))
        })
        .collect()
}

/// The gateway, through the app's TCGplayer client and its rate limits.
#[derive(Clone)]
pub struct TcgPlayerMarket(pub TcgPlayer);

impl MarketData for TcgPlayerMarket {
    async fn price_points(&self, skus: &[i64]) -> Result<HashMap<i64, PricePoint>, String> {
        let answers: Vec<Answer> = self
            .0
            .post(
                Domain::MpGateway,
                PATH,
                &Search { sku_ids: skus },
                Call::default(),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(by_sku(answers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_and_answer_read_as_the_gateway_writes_them() {
        assert_eq!(
            serde_json::to_string(&Search { sku_ids: &[41, 42] }).unwrap(),
            r#"{"skuIds":[41,42]}"#
        );
        let answers: Vec<Answer> = serde_json::from_str(
            r#"[
                {"skuId":41,"marketPrice":4.25,"lowestPrice":3.5,"highestPrice":5,"priceCount":7,"calculatedAt":"2026-09-07T14:05:00.000Z"},
                {"skuId":42,"marketPrice":null,"lowestPrice":null,"highestPrice":null,"priceCount":0,"calculatedAt":"2026-09-07T14:05:00.000Z"}
            ]"#,
        )
        .unwrap();
        let points = by_sku(answers);
        assert_eq!(
            points.get(&41),
            Some(&PricePoint {
                market_price: 4.25,
                lowest_price: 3.5,
                highest_price: 5.0,
                price_count: 7.0,
            })
        );
        assert!(!points.contains_key(&42));
    }
}
