//! The two reads of TCGplayer's order management API the history makes: a page of the seller's
//! orders from the last three months, oldest first, and one order's detail. Ported from
//! `search-seller-orders.server.ts` and `get-seller-order.server.ts`.
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{observation::Fields, sync::Orders};
use crate::{
    features::http_configuration::config::Domain,
    tcgplayer::{Call, Failure, TcgPlayer},
};

const SEARCH: &str = "/orders/search?api-version=2.0";

/// Each read is one attempt of at most ten seconds; a failed one is a gap the next run retries.
const ONCE: Call = Call {
    retry: false,
    timeout: Duration::from_secs(10),
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Search<'a> {
    search_range: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<Query<'a>>,
    filters: Filters<'a>,
    sort_by: [Sort; 1],
    from: u32,
    size: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Query<'a> {
    order_number: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Filters<'a> {
    seller_key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sort {
    sorting_type: &'static str,
    direction: &'static str,
}

impl<'a> Search<'a> {
    fn new(seller_key: &'a str, from: u32, size: u32) -> Self {
        Search {
            search_range: "LastThreeMonths",
            query: None,
            filters: Filters { seller_key },
            sort_by: [Sort {
                sorting_type: "orderDate",
                direction: "ascending",
            }],
            from,
            size,
        }
    }
}

/// A page of search results: how many orders the search has, and this page's, as the API sent
/// them (their fingerprints are taken over the fields as sent).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub total_orders: u32,
    pub orders: Vec<Fields>,
}

/// The seller's orders from `from`, `size` of them.
pub async fn search(
    tcg: &TcgPlayer,
    seller_key: &str,
    from: u32,
    size: u32,
) -> Result<SearchPage, Failure> {
    let search = Search::new(seller_key, from, size);
    tcg.post(Domain::OrderManagementApi, SEARCH, &search, ONCE)
        .await
}

/// The search result for one order, when the seller has it: the sync checks an order it is asked
/// to read first is the seller's.
pub async fn find(
    tcg: &TcgPlayer,
    seller_key: &str,
    order_number: &str,
) -> Result<Option<Fields>, Failure> {
    let search = Search {
        query: Some(Query { order_number }),
        ..Search::new(seller_key, 0, 25)
    };
    let page: SearchPage = tcg
        .post(Domain::OrderManagementApi, SEARCH, &search, ONCE)
        .await?;
    Ok(page
        .orders
        .into_iter()
        .find(|o| o.get("orderNumber").and_then(|n| n.as_str()) == Some(order_number)))
}

/// One order's detail.
pub async fn order(tcg: &TcgPlayer, order_number: &str) -> Result<Fields, Failure> {
    let path = format!("/orders/{}?api-version=2.0", component(order_number));
    tcg.get(Domain::OrderManagementApi, &path, ONCE).await
}

/// `text` as JavaScript's `encodeURIComponent` writes it.
fn component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// TCGplayer's order management API, read live.
pub struct OrderManagement<'a>(pub &'a TcgPlayer);

impl Orders for OrderManagement<'_> {
    async fn search(&self, seller: &str, from: u32, size: u32) -> Result<SearchPage, Failure> {
        search(self.0, seller, from, size).await
    }
    async fn find(&self, seller: &str, number: &str) -> Result<Option<Fields>, Failure> {
        find(self.0, seller, number).await
    }
    async fn order(&self, number: &str) -> Result<Fields, Failure> {
        order(self.0, number).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_search_is_sent_as_the_node_app_sent_it() {
        let page = serde_json::to_value(Search::new("abc", 450, 500)).unwrap();
        assert_eq!(
            page,
            json!({
                "searchRange": "LastThreeMonths",
                "filters": { "sellerKey": "abc" },
                "sortBy": [{ "sortingType": "orderDate", "direction": "ascending" }],
                "from": 450,
                "size": 500,
            })
        );
        let one = Search {
            query: Some(Query {
                order_number: "A-1",
            }),
            ..Search::new("abc", 0, 25)
        };
        assert_eq!(
            serde_json::to_value(one).unwrap()["query"],
            json!({ "orderNumber": "A-1" })
        );
    }

    #[test]
    fn an_order_number_is_encoded_as_a_path_component() {
        assert_eq!(component("8520A14F-A1B2C3-D4E5F"), "8520A14F-A1B2C3-D4E5F");
        assert_eq!(component("a b/c?"), "a%20b%2Fc%3F");
    }
}
