//! One batch's evidence requests made once each (`PricingBatchApiCache`): every SKU of a product
//! in a variant and language reads the same latest sales, and every SKU of a product the same
//! price history.
use std::{collections::HashMap, sync::Mutex};

use crate::features::pricing::{
    sale::Sale,
    sku_price::{Evidence, Failure, History, Sku},
    supply_analysis::Observation as Supply,
};

/// A product's sales in a variant and language.
type SalesKey = (i64, String, String);

pub struct Cached<'a, E> {
    evidence: &'a E,
    sales: Mutex<HashMap<SalesKey, Result<Vec<Sale>, Failure>>>,
    history: Mutex<HashMap<i64, Option<Vec<History>>>>,
}

impl<'a, E> Cached<'a, E> {
    pub fn new(evidence: &'a E) -> Self {
        Cached {
            evidence,
            sales: Mutex::default(),
            history: Mutex::default(),
        }
    }
}

impl<E: Evidence> Evidence for Cached<'_, E> {
    async fn latest_sales(&self, sku: &Sku) -> Result<Vec<Sale>, Failure> {
        let key = (sku.product_id, sku.variant.clone(), sku.language.clone());
        if let Some(known) = self.sales.lock().expect("sales lock").get(&key) {
            return known.clone();
        }
        let read = self.evidence.latest_sales(sku).await;
        self.sales
            .lock()
            .expect("sales lock")
            .insert(key, read.clone());
        read
    }

    async fn price_history(&self, product_id: i64) -> Option<Vec<History>> {
        if let Some(known) = self.history.lock().expect("history lock").get(&product_id) {
            return known.clone();
        }
        let read = self.evidence.price_history(product_id).await;
        self.history
            .lock()
            .expect("history lock")
            .insert(product_id, read.clone());
        read
    }

    async fn listings(&self, sku: &Sku, ceiling: Option<f64>, excluded: Option<&str>) -> Supply {
        self.evidence.listings(sku, ceiling, excluded).await
    }

    async fn lowest_listing_price(&self, sku: &Sku, excluded: Option<&str>) -> Option<f64> {
        self.evidence.lowest_listing_price(sku, excluded).await
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::features::pricing::policy::SupplyStatus;

    #[derive(Default)]
    struct Counting {
        sales: Cell<usize>,
        history: Cell<usize>,
    }

    impl Evidence for Counting {
        async fn latest_sales(&self, _: &Sku) -> Result<Vec<Sale>, Failure> {
            self.sales.set(self.sales.get() + 1);
            Ok(vec![Sale::default()])
        }
        async fn price_history(&self, _: i64) -> Option<Vec<History>> {
            self.history.set(self.history.get() + 1);
            None
        }
        async fn listings(&self, _: &Sku, _: Option<f64>, _: Option<&str>) -> Supply {
            Supply {
                status: SupplyStatus::Unavailable,
                listings: Vec::new(),
            }
        }
        async fn lowest_listing_price(&self, _: &Sku, _: Option<&str>) -> Option<f64> {
            None
        }
    }

    fn sku(sku: i64, product_id: i64, condition: &str, language: &str) -> Sku {
        Sku {
            sku,
            product_id,
            product_line_id: 1,
            condition: condition.into(),
            variant: "Normal".into(),
            language: language.into(),
        }
    }

    #[tokio::test]
    async fn each_product_variant_and_language_is_read_once() {
        let counting = Counting::default();
        let cached = Cached::new(&counting);
        cached
            .latest_sales(&sku(1, 10, "Near Mint", "English"))
            .await
            .unwrap();
        cached
            .latest_sales(&sku(2, 10, "Lightly Played", "English"))
            .await
            .unwrap();
        cached
            .latest_sales(&sku(3, 10, "Near Mint", "Japanese"))
            .await
            .unwrap();
        cached.price_history(10).await;
        cached.price_history(10).await;
        assert_eq!((counting.sales.get(), counting.history.get()), (2, 1));
    }
}
