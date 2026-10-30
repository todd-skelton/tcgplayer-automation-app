//! One step of the seller order history's scan of TCGplayer, as `synchronizeSellerOrders.server.ts`
//! takes it: within a budget of searches and details, it reads the orders it was asked about
//! first, retries the details it missed, then reads pages of the last three months oldest first,
//! a few orders of the page before again so one that moved is not missed, and records each order
//! whose search result changed. Called again, it resumes where the run stopped, until every page
//! and every detail is read. A store that holds the run decides where its records go: Node's
//! tables, or (in shadow) a log of what would be recorded.
use std::collections::HashSet;

use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    api::SearchPage,
    observation::{self, Fields, Observation},
};
use crate::tcgplayer::Failure;

/// How much one step may read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub max_pages: u32,
    pub max_details: usize,
    pub page_size: u32,
    pub detail_concurrency: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max_pages: 1,
            max_details: 25,
            page_size: 500,
            detail_concurrency: 5,
        }
    }
}

impl Budget {
    /// The budget, or why TCGplayer must not be asked for that much.
    pub fn checked(self) -> Result<Self, String> {
        for (value, name) in [
            (self.max_pages as usize, "maxPages"),
            (self.max_details, "maxDetails"),
            (self.page_size as usize, "pageSize"),
            (self.detail_concurrency, "detailConcurrency"),
        ] {
            if value == 0 {
                return Err(format!("{name} must be positive."));
            }
        }
        if self.page_size < 2 {
            return Err("pageSize must be at least 2 so resumed scans can overlap.".into());
        }
        if self.max_pages > 4
            || self.max_details > 100
            || self.page_size > 500
            || self.detail_concurrency > 10
        {
            return Err("Seller order sync budget exceeds the safe request limit.".into());
        }
        Ok(self)
    }
}

/// An order whose detail a run has not read yet, with its search result when it came from one
/// (without the buyer, which the history never keeps).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub order_number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Fields>,
}

/// A run being resumed: where its scan is.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub id: i64,
    pub next_offset: u32,
    pub expected_total: Option<u32>,
    pub pages_completed: u32,
    pub gaps: Vec<Gap>,
}

/// What the history covers, after a step.
#[derive(Clone, Debug, PartialEq)]
pub struct Coverage {
    /// `running`, `complete` or `incomplete`.
    pub status: String,
    pub orders_observed: u32,
    pub details_recorded: u32,
    pub next_offset: u32,
    pub expected_total: Option<u32>,
    pub gaps: Vec<Gap>,
    pub error: Option<String>,
}

/// A run kept in this process: where its scan is and the orders it has seen, as the run's row
/// and its orders' rows keep them in the database.
pub struct MemoryRun {
    state: std::sync::Mutex<(Coverage, HashSet<String>)>,
}

impl Default for MemoryRun {
    fn default() -> Self {
        MemoryRun::at(0, None, &[])
    }
}

impl MemoryRun {
    /// A run resumed at `next_offset`, having seen `seen`.
    pub fn at(next_offset: u32, expected_total: Option<u32>, seen: &[&str]) -> Self {
        let seen: HashSet<String> = seen.iter().map(|s| (*s).to_owned()).collect();
        let coverage = Coverage {
            status: "incomplete".into(),
            orders_observed: seen.len() as u32,
            details_recorded: 0,
            next_offset,
            expected_total,
            gaps: Vec::new(),
            error: None,
        };
        MemoryRun {
            state: std::sync::Mutex::new((coverage, seen)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (Coverage, HashSet<String>)> {
        self.state.lock().expect("run lock")
    }

    pub fn start(&self) -> Run {
        let mut s = self.lock();
        if s.0.status == "complete" {
            // A finished scan starts a new one, as a new run row does.
            *s = MemoryRun::default().state.into_inner().expect("run lock");
        }
        s.0.status = "running".into();
        Run {
            id: 1,
            next_offset: s.0.next_offset,
            expected_total: s.0.expected_total,
            pages_completed: u32::from(s.0.expected_total.is_some()),
            gaps: s.0.gaps.clone(),
        }
    }

    pub fn coverage(&self) -> Coverage {
        self.lock().0.clone()
    }

    pub fn save(&self, p: &Progress<'_>) -> Coverage {
        let mut s = self.lock();
        for n in p.order_numbers.iter().flatten() {
            s.1.insert(n.clone());
        }
        s.0.next_offset = p.next_offset;
        s.0.expected_total = p.expected_total;
        s.0.orders_observed = s.1.len() as u32;
        s.0.details_recorded += p.detail_count;
        s.0.gaps = p.gaps.to_vec();
        s.0.clone()
    }

    pub fn finish(&self, complete: bool, error: Option<&str>) -> Coverage {
        let mut s = self.lock();
        s.0.status = if complete { "complete" } else { "incomplete" }.into();
        s.0.error = error.map(str::to_owned);
        s.0.clone()
    }

    pub fn restart(&self, error: &str) -> Coverage {
        let mut s = self.lock();
        s.1.clear();
        s.0.next_offset = 0;
        s.0.expected_total = None;
        s.0.orders_observed = 0;
        s.0.status = "incomplete".into();
        s.0.error = Some(error.into());
        s.0.clone()
    }
}

/// What a step read, saved as the run's checkpoint.
#[derive(Clone, Debug, PartialEq)]
pub struct Progress<'a> {
    pub run: &'a Run,
    pub claim: &'a str,
    pub next_offset: u32,
    pub expected_total: Option<u32>,
    pub page_offset: Option<u32>,
    pub page_order_count: u32,
    pub page_completed: bool,
    pub detail_count: u32,
    pub observed_times: Vec<String>,
    pub gaps: &'a [Gap],
    pub complete: bool,
    pub order_numbers: Option<Vec<String>>,
}

/// Where a run is kept and its orders are recorded (`sellerOrderHistory.server.ts`).
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Store {
    /// The seller's run to resume, claimed with `claim`; `None` while another holds it.
    async fn start_or_resume(&self, seller: &str, claim: &str) -> Result<Option<Run>, String>;
    async fn coverage(&self, seller: &str) -> Result<Coverage, String>;
    /// Records the order; whether it changed what the history holds.
    async fn record(
        &self,
        run: &Run,
        claim: &str,
        observation: &Observation,
    ) -> Result<bool, String>;
    /// Of these orders and their search results' fingerprints, those whose detail must be read.
    async fn details_needed(
        &self,
        seller: &str,
        summaries: &[(String, String)],
    ) -> Result<HashSet<String>, String>;
    /// Of these orders, those the history last read from the API.
    async fn api_verified(
        &self,
        seller: &str,
        numbers: &[String],
    ) -> Result<HashSet<String>, String>;
    async fn save_progress(&self, progress: Progress<'_>) -> Result<Coverage, String>;
    async fn finish(
        &self,
        run: &Run,
        claim: &str,
        complete: bool,
        error: Option<&str>,
    ) -> Result<Coverage, String>;
    /// Starts the scan over, because the search moved under it.
    async fn restart(&self, run: &Run, claim: &str, error: &str) -> Result<Coverage, String>;
}

/// TCGplayer's order management API, or a stand-in.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Orders {
    async fn search(&self, seller: &str, from: u32, size: u32) -> Result<SearchPage, Failure>;
    async fn find(&self, seller: &str, number: &str) -> Result<Option<Fields>, Failure>;
    async fn order(&self, number: &str) -> Result<Fields, Failure>;
}

/// What a step did.
#[derive(Clone, Debug, PartialEq)]
pub struct Synced {
    pub coverage: Coverage,
    /// The orders whose record changed.
    pub changed: Vec<String>,
}

fn number_of(fields: &Fields) -> &str {
    fields
        .get("orderNumber")
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// A search result with only the fields the history reads, for a gap.
pub fn sanitized(summary: &Fields) -> Fields {
    [
        "orderNumber",
        "orderDate",
        "orderChannel",
        "orderStatus",
        "shippingType",
        "productAmount",
        "shippingAmount",
        "totalAmount",
        "buyerPaid",
        "orderFulfillment",
    ]
    .iter()
    .filter_map(|k| summary.get(*k).map(|v| ((*k).to_owned(), v.clone())))
    .collect()
}

/// The search result an order read without one stands on: its number, nothing else.
fn placeholder(number: &str) -> Fields {
    let mut f = Map::new();
    f.insert("orderNumber".into(), number.into());
    for key in [
        "orderDate",
        "orderChannel",
        "orderStatus",
        "buyerName",
        "shippingType",
    ] {
        f.insert(key.into(), "".into());
    }
    for key in ["productAmount", "shippingAmount", "totalAmount"] {
        f.insert(key.into(), 0.into());
    }
    f.insert("buyerPaid".into(), false.into());
    f.insert("orderFulfillment".into(), "".into());
    f
}

/// An order's detail recorded: its number, whether the history changed, and when it was placed.
struct Recorded {
    number: String,
    changed: bool,
    time: String,
}

/// What reading a set of details did.
struct Details {
    changed: Vec<String>,
    recorded: u32,
    gaps: Vec<Fields>,
    times: Vec<String>,
}

struct Step<'a, O, S> {
    orders: &'a O,
    store: &'a S,
    seller: &'a str,
    run: &'a Run,
    claim: &'a str,
    concurrency: usize,
    now: &'a (dyn Fn() -> String + Sync),
}

impl<O: Orders, S: Store> Step<'_, O, S> {
    async fn one(&self, summary: &Fields) -> Result<Recorded, String> {
        let number = number_of(summary);
        let detail = self.orders.order(number).await.map_err(|e| e.to_string())?;
        if number_of(&detail).trim() != number.trim() {
            return Err("detail order number did not match search result".into());
        }
        let observation = observation::observe(self.seller, Some(summary), &detail, &(self.now)())?;
        let changed = self
            .store
            .record(self.run, self.claim, &observation)
            .await?;
        let time = detail
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Ok(Recorded {
            number: number_of(&detail).to_owned(),
            changed,
            time,
        })
    }

    async fn read(&self, summary: Fields) -> (Fields, Result<Recorded, String>) {
        let read = self.one(&summary).await;
        (summary, read)
    }

    async fn details(&self, summaries: Vec<Fields>) -> Details {
        // Futures made first: a stream that maps to borrowed futures is not Send for every lifetime.
        let reads: Vec<_> = summaries
            .into_iter()
            .map(|summary| self.read(summary))
            .collect();
        let results: Vec<(Fields, Result<Recorded, String>)> = stream::iter(reads)
            .buffered(self.concurrency)
            .collect()
            .await;
        let mut out = Details {
            changed: Vec::new(),
            recorded: 0,
            gaps: Vec::new(),
            times: Vec::new(),
        };
        for (summary, read) in results {
            match read {
                Ok(Recorded {
                    number,
                    changed,
                    time,
                }) => {
                    out.recorded += 1;
                    if changed {
                        out.changed.push(number);
                    }
                    if !time.is_empty() {
                        out.times.push(time);
                    }
                }
                Err(why) => {
                    eprintln!(
                        "Seller order {} detail was not recorded: Error: {why}",
                        number_of(&summary)
                    );
                    out.gaps.push(summary);
                }
            }
        }
        out
    }
}

fn add_changed(into: &mut Vec<String>, changed: Vec<String>) {
    for number in changed {
        if !into.contains(&number) {
            into.push(number);
        }
    }
}

/// One step of the seller's scan within `budget`, reading `priority`'s orders first.
pub async fn synchronize<O: Orders, S: Store>(
    orders: &O,
    store: &S,
    seller: &str,
    budget: Budget,
    priority: &[String],
    claim: &str,
    now: &(dyn Fn() -> String + Sync),
) -> Result<Synced, String> {
    let seller = seller.trim();
    if seller.is_empty() {
        return Err("Seller key is required.".into());
    }
    let budget = budget.checked()?;
    let Some(run) = store.start_or_resume(seller, claim).await? else {
        return Ok(Synced {
            coverage: store.coverage(seller).await?,
            changed: Vec::new(),
        });
    };
    let mut changed = Vec::new();
    let step = Step {
        orders,
        store,
        seller,
        run: &run,
        claim,
        concurrency: budget.detail_concurrency,
        now,
    };
    match scan(&step, budget, priority, &mut changed).await {
        Ok(coverage) => Ok(Synced { coverage, changed }),
        Err(why) => {
            let coverage = store
                .finish(&run, claim, false, Some(&format!("Error: {why}")))
                .await?;
            Ok(Synced { coverage, changed })
        }
    }
}

async fn scan<O: Orders, S: Store>(
    step: &Step<'_, O, S>,
    budget: Budget,
    priority: &[String],
    changed: &mut Vec<String>,
) -> Result<Coverage, String> {
    let (run, store, seller, claim) = (step.run, step.store, step.seller, step.claim);
    let mut detail_budget = budget.max_details;
    let mut next_offset = run.next_offset;
    let mut expected_total = run.expected_total;
    let observed_page = run.pages_completed > 0;
    let mut gaps = run.gaps.clone();

    // The orders asked about first, each checked to be the seller's by a search.
    let mut requested: Vec<String> = Vec::new();
    for number in priority.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !requested.iter().any(|r| r == number) {
            requested.push(number.to_owned());
        }
    }
    requested.truncate(detail_budget);
    let verified = store.api_verified(seller, &requested).await?;
    let unverified: Vec<&String> = requested
        .iter()
        .filter(|n| !verified.contains(*n))
        .collect();
    let finds: Vec<_> = unverified
        .into_iter()
        .map(|number| step.orders.find(seller, number))
        .collect();
    let found: Vec<Result<Option<Fields>, Failure>> = stream::iter(finds)
        .buffered(budget.detail_concurrency)
        .collect()
        .await;
    let mut found_now: Vec<Fields> = Vec::new();
    for summary in found {
        if let Some(summary) = summary.map_err(|e| e.to_string())? {
            found_now.push(summary);
        }
    }
    let first: Vec<&String> = requested
        .iter()
        .filter(|n| verified.contains(*n) || found_now.iter().any(|s| number_of(s) == n.as_str()))
        .collect();
    if !first.is_empty() {
        let summaries = first
            .iter()
            .map(|n| {
                found_now
                    .iter()
                    .find(|s| number_of(s) == n.as_str())
                    .cloned()
                    .unwrap_or_else(|| placeholder(n))
            })
            .collect();
        let read = step.details(summaries).await;
        add_changed(changed, read.changed);
        let mut next: Vec<Gap> = read
            .gaps
            .iter()
            .map(|s| Gap {
                order_number: number_of(s).to_owned(),
                summary: None,
            })
            .collect();
        next.extend(
            gaps.into_iter()
                .filter(|g| !first.contains(&&g.order_number)),
        );
        gaps = next;
        detail_budget -= first.len();
        store
            .save_progress(Progress {
                run,
                claim,
                next_offset,
                expected_total,
                page_offset: None,
                page_order_count: 0,
                page_completed: false,
                detail_count: read.recorded,
                observed_times: read.times,
                gaps: &gaps,
                complete: false,
                order_numbers: None,
            })
            .await?;
    }

    // Details missed before, retried.
    if !gaps.is_empty() && detail_budget > 0 {
        let retry = gaps.len().min(detail_budget);
        let summaries = gaps[..retry]
            .iter()
            .map(|g| match &g.summary {
                Some(s) => {
                    let mut s = s.clone();
                    s.insert("buyerName".into(), "".into());
                    s
                }
                None => placeholder(&g.order_number),
            })
            .collect();
        let read = step.details(summaries).await;
        add_changed(changed, read.changed);
        let mut next: Vec<Gap> = read
            .gaps
            .iter()
            .map(|s| Gap {
                order_number: number_of(s).to_owned(),
                summary: Some(sanitized(s)),
            })
            .collect();
        next.extend(gaps.drain(retry..));
        gaps = next;
        detail_budget -= retry;
        store
            .save_progress(Progress {
                run,
                claim,
                next_offset,
                expected_total,
                page_offset: None,
                page_order_count: 0,
                page_completed: false,
                detail_count: read.recorded,
                observed_times: read.times,
                gaps: &gaps,
                complete: false,
                order_numbers: None,
            })
            .await?;
        if detail_budget == 0 {
            let complete = observed_page
                && expected_total.is_some_and(|t| next_offset >= t)
                && gaps.is_empty();
            let error = (!complete)
                .then_some("Detail retry budget was exhausted before all gaps were resolved.");
            return store.finish(run, claim, complete, error).await;
        }
    }

    let mut coverage = store.coverage(seller).await?;
    let size = budget.page_size;
    let mut page = 0;
    while page < budget.max_pages && detail_budget > 0 {
        page += 1;
        let overlap = if next_offset == 0 {
            0
        } else {
            (size - 1).min(25).min((size / 10).max(1))
        };
        let page_offset = next_offset.saturating_sub(overlap);
        let found = step
            .orders
            .search(seller, page_offset, size)
            .await
            .map_err(|e| e.to_string())?;
        let total = found.total_orders;
        expected_total = Some(total);
        if found.orders.is_empty() && page_offset < total {
            let why = format!(
                "Search returned an empty page at offset {page_offset} before reported total {total}."
            );
            return store.restart(run, claim, &why).await;
        }
        let fingerprints = found
            .orders
            .iter()
            .map(|s| {
                Ok((
                    number_of(s).to_owned(),
                    observation::summary_fingerprint(s)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let needed = store.details_needed(seller, &fingerprints).await?;
        let needed: Vec<&Fields> = found
            .orders
            .iter()
            .filter(|s| needed.contains(number_of(s)))
            .collect();
        let take = needed.len().min(detail_budget);
        let read = step
            .details(needed[..take].iter().map(|s| (*s).clone()).collect())
            .await;
        add_changed(changed, read.changed);
        for summary in read.gaps.iter().chain(needed[take..].iter().copied()) {
            let gap = Gap {
                order_number: number_of(summary).to_owned(),
                summary: Some(sanitized(summary)),
            };
            match gaps.iter_mut().find(|g| g.order_number == gap.order_number) {
                Some(kept) => *kept = gap,
                None => gaps.push(gap),
            }
        }
        let count = found.orders.len() as u32;
        next_offset = next_offset.max(page_offset + count);
        detail_budget -= take;
        let reached_end = count < size || next_offset >= total;
        let mut complete = reached_end && gaps.is_empty();
        let before = coverage.orders_observed;
        let mut observed_times = read.times;
        observed_times.extend(found.orders.iter().map(|s| {
            s.get("orderDate")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        }));
        coverage = store
            .save_progress(Progress {
                run,
                claim,
                next_offset,
                expected_total,
                page_offset: Some(page_offset),
                page_order_count: count,
                page_completed: true,
                detail_count: read.recorded,
                observed_times,
                gaps: &gaps,
                complete,
                order_numbers: Some(
                    found
                        .orders
                        .iter()
                        .map(|s| number_of(s).to_owned())
                        .collect(),
                ),
            })
            .await?;
        if count > 0 && coverage.orders_observed == before && coverage.orders_observed < total {
            let why = format!(
                "Search repeated a page without new order identities at offset {}.",
                next_offset - count
            );
            return store.restart(run, claim, &why).await;
        }
        complete = complete && coverage.orders_observed >= total;
        if reached_end {
            if gaps.is_empty() && coverage.orders_observed < total {
                let why = format!(
                    "Search changed during pagination ({} unique orders for reported total {total}); restarting with overlap.",
                    coverage.orders_observed
                );
                return store.restart(run, claim, &why).await;
            }
            let error = (!complete).then_some(
                "All search pages were read, but one or more order details are still missing.",
            );
            return store.finish(run, claim, complete, error).await;
        }
    }
    store
        .finish(
            run,
            claim,
            false,
            Some("Sync request budget reached; resume from the saved offset."),
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use serde_json::json;

    use super::*;

    fn summary(number: &str) -> Fields {
        json!({
            "orderNumber": number, "orderDate": "2026-08-10T14:00:00.000Z",
            "orderChannel": "TcgMarketplace", "orderStatus": "Completed - Paid", "buyerName": "",
            "shippingType": "Standard", "productAmount": 1, "shippingAmount": 0,
            "totalAmount": 1, "buyerPaid": true, "orderFulfillment": "Normal",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn detail(number: &str) -> Fields {
        json!({
            "createdAt": "2026-08-10T14:00:00.440Z", "status": "Completed - Paid",
            "orderChannel": "TcgMarketplace", "orderFulfillment": "Normal", "orderNumber": number,
            "sellerName": "", "buyerName": "", "paymentType": "", "pickupStatus": "",
            "shippingType": "Standard", "estimatedDeliveryDate": "",
            "transaction": { "productAmount": 1, "shippingAmount": 0, "grossAmount": 1,
              "feeAmount": 0, "netAmount": 1, "directFeeAmount": 0, "taxes": [] },
            "products": [{ "name": "Card", "unitPrice": 1, "extendedPrice": 1, "quantity": 1,
              "url": "", "productId": "10", "skuId": "100" }],
            "refunds": [], "refundStatus": "No Refund", "trackingNumbers": [], "allowedActions": [],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    /// A stand-in for TCGplayer: a list of orders paged by offset.
    #[derive(Default)]
    struct Fake {
        list: Mutex<Vec<Fields>>,
        total: Option<u32>,
        /// Every search answers the list's start, wherever it is asked.
        same_page: bool,
        /// Orders a lookup by number finds; `None`: any.
        known: Option<Vec<String>>,
        delay: Option<Duration>,
        failing_details: bool,
        searches: Mutex<Vec<(Option<String>, u32)>>,
        details: AtomicUsize,
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    impl Fake {
        fn of(numbers: &[&str]) -> Self {
            Fake {
                list: Mutex::new(numbers.iter().map(|n| summary(n)).collect()),
                ..Fake::default()
            }
        }
    }

    impl Orders for Fake {
        async fn search(&self, _: &str, from: u32, size: u32) -> Result<SearchPage, Failure> {
            self.searches.lock().unwrap().push((None, from));
            let list = self.list.lock().unwrap().clone();
            let from = if self.same_page { 0 } else { from as usize };
            let orders = list
                .iter()
                .skip(from)
                .take(size as usize)
                .cloned()
                .collect();
            Ok(SearchPage {
                total_orders: self.total.unwrap_or(list.len() as u32),
                orders,
            })
        }

        async fn find(&self, _: &str, number: &str) -> Result<Option<Fields>, Failure> {
            self.searches
                .lock()
                .unwrap()
                .push((Some(number.to_owned()), 0));
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            let known = self
                .known
                .as_ref()
                .is_none_or(|k| k.iter().any(|n| n == number));
            Ok(known.then(|| summary(number)))
        }

        async fn order(&self, number: &str) -> Result<Fields, Failure> {
            self.details.fetch_add(1, Ordering::SeqCst);
            if self.failing_details {
                return Err(Failure::Unreachable("safe failure".into()));
            }
            Ok(detail(number))
        }
    }

    /// The run in memory, as the Node test's fake repository keeps it.
    struct Memory {
        run: MemoryRun,
        acquired: bool,
        needed: Option<Vec<String>>,
        verified: bool,
        saved_gaps: Mutex<Vec<Gap>>,
    }

    impl Memory {
        fn new() -> Self {
            Memory::at(0, None, &[])
        }

        fn at(next_offset: u32, expected_total: Option<u32>, seen: &[&str]) -> Self {
            Memory {
                run: MemoryRun::at(next_offset, expected_total, seen),
                acquired: true,
                needed: None,
                verified: true,
                saved_gaps: Mutex::new(Vec::new()),
            }
        }
    }

    impl Store for Memory {
        async fn start_or_resume(&self, _: &str, _: &str) -> Result<Option<Run>, String> {
            let run = self.run.start();
            Ok(self.acquired.then_some(run))
        }
        async fn coverage(&self, _: &str) -> Result<Coverage, String> {
            Ok(self.run.coverage())
        }
        async fn record(&self, _: &Run, _: &str, _: &Observation) -> Result<bool, String> {
            Ok(true)
        }
        async fn details_needed(
            &self,
            _: &str,
            summaries: &[(String, String)],
        ) -> Result<HashSet<String>, String> {
            Ok(match &self.needed {
                Some(n) => n.iter().cloned().collect(),
                None => summaries.iter().map(|(n, _)| n.clone()).collect(),
            })
        }
        async fn api_verified(
            &self,
            _: &str,
            numbers: &[String],
        ) -> Result<HashSet<String>, String> {
            Ok(if self.verified {
                numbers.iter().cloned().collect()
            } else {
                HashSet::new()
            })
        }
        async fn save_progress(&self, p: Progress<'_>) -> Result<Coverage, String> {
            *self.saved_gaps.lock().unwrap() = p.gaps.to_vec();
            Ok(self.run.save(&p))
        }
        async fn finish(
            &self,
            _: &Run,
            _: &str,
            complete: bool,
            error: Option<&str>,
        ) -> Result<Coverage, String> {
            Ok(self.run.finish(complete, error))
        }
        async fn restart(&self, _: &Run, _: &str, error: &str) -> Result<Coverage, String> {
            Ok(self.run.restart(error))
        }
    }

    fn now() -> String {
        "2026-09-07T00:00:00.000Z".into()
    }

    async fn sync(fake: &Fake, store: &Memory, budget: Budget, priority: &[&str]) -> Synced {
        let priority: Vec<String> = priority.iter().map(|s| s.to_string()).collect();
        synchronize(fake, store, "seller-a", budget, &priority, "claim", &now)
            .await
            .unwrap()
    }

    fn budget(
        max_pages: u32,
        max_details: usize,
        page_size: u32,
        detail_concurrency: usize,
    ) -> Budget {
        Budget {
            max_pages,
            max_details,
            page_size,
            detail_concurrency,
        }
    }

    #[tokio::test]
    async fn an_order_asked_about_is_looked_up_once_then_read() {
        let fake = Fake {
            known: Some(vec!["NEW".into()]),
            ..Fake::default()
        };
        let store = Memory {
            verified: false,
            ..Memory::new()
        };
        sync(&fake, &store, budget(1, 1, 2, 1), &["NEW"]).await;
        let searched: Vec<_> = fake
            .searches
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.0.clone())
            .collect();
        assert_eq!(searched, [Some("NEW".to_owned())]);
        assert_eq!(fake.details.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn lookups_keep_to_the_concurrency() {
        let fake = Fake {
            delay: Some(Duration::from_millis(5)),
            ..Fake::default()
        };
        let store = Memory {
            verified: false,
            ..Memory::new()
        };
        sync(&fake, &store, budget(1, 4, 4, 2), &["P1", "P2", "P3", "P4"]).await;
        assert_eq!(fake.peak.load(Ordering::SeqCst), 2);
        assert_eq!(fake.active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_page_already_recorded_reads_no_details_and_completes() {
        let numbers: Vec<String> = (0..500).map(|i| format!("FRESH-{i}")).collect();
        let refs: Vec<&str> = numbers.iter().map(String::as_str).collect();
        let fake = Fake::of(&refs);
        let store = Memory {
            needed: Some(Vec::new()),
            ..Memory::new()
        };
        let done = sync(&fake, &store, Budget::default(), &[]).await;
        assert_eq!(fake.details.load(Ordering::SeqCst), 0);
        assert_eq!(done.coverage.status, "complete");
        assert_eq!(done.coverage.orders_observed, 500);
    }

    #[tokio::test]
    async fn pages_overlap_and_the_scan_completes() {
        let fake = Fake::of(&["A", "B", "C"]);
        let store = Memory::new();
        let done = sync(&fake, &store, budget(2, 4, 2, 2), &[]).await;
        let offsets: Vec<u32> = fake.searches.lock().unwrap().iter().map(|s| s.1).collect();
        assert_eq!(offsets, [0, 1]);
        assert_eq!(done.coverage.status, "complete");
        assert_eq!(done.coverage.orders_observed, 3);
        let changed: HashSet<_> = done.changed.into_iter().collect();
        assert_eq!(changed, HashSet::from(["A".into(), "B".into(), "C".into()]));
    }

    #[test]
    fn an_unsafe_budget_is_refused() {
        let small = Budget {
            page_size: 1,
            ..Budget::default()
        }
        .checked();
        assert!(small.unwrap_err().contains("at least 2"));
        let wide = Budget {
            detail_concurrency: 11,
            ..Budget::default()
        }
        .checked();
        assert!(wide.unwrap_err().contains("safe request limit"));
    }

    #[tokio::test]
    async fn a_repeated_page_starts_the_scan_over() {
        let fake = Fake {
            total: Some(4),
            same_page: true,
            ..Fake::of(&["A", "B"])
        };
        let store = Memory::at(2, Some(4), &["A", "B"]);
        let done = sync(&fake, &store, Budget::default(), &[]).await;
        assert_eq!(done.coverage.status, "incomplete");
        assert!(done.coverage.error.unwrap().contains("repeated a page"));
        assert_eq!(done.coverage.next_offset, 0);
    }

    #[tokio::test]
    async fn a_shifted_search_is_caught_by_the_overlap() {
        let fake = Fake::of(&["A", "B", "C", "D"]);
        let store = Memory::new();
        let step = budget(1, 2, 2, 2);
        assert_eq!(sync(&fake, &store, step, &[]).await.coverage.next_offset, 2);
        *fake.list.lock().unwrap() = ["B", "C", "D", "E"].iter().map(|n| summary(n)).collect();
        let overlap = sync(&fake, &store, step, &[]).await;
        assert_eq!(overlap.coverage.next_offset, 3);
        assert!(overlap.changed.contains(&"C".to_owned()));
        let completed = sync(&fake, &store, step, &[]).await;
        assert_eq!(completed.coverage.status, "complete");
        assert_eq!(store.run.coverage().orders_observed, 5);
    }

    #[tokio::test]
    async fn an_empty_page_before_the_total_starts_over() {
        let fake = Fake {
            total: Some(2),
            ..Fake::of(&[])
        };
        let store = Memory::at(1, Some(2), &[]);
        let done = sync(&fake, &store, Budget::default(), &[]).await;
        assert_eq!(done.coverage.status, "incomplete");
        assert!(done.coverage.error.unwrap().contains("empty page"));
    }

    #[tokio::test]
    async fn a_gap_keeps_no_buyer() {
        let mut private = summary("PRIVATE-GAP");
        private.insert("buyerName".into(), "DO-NOT-PERSIST".into());
        let fake = Fake {
            list: Mutex::new(vec![private]),
            failing_details: true,
            ..Fake::default()
        };
        let store = Memory::new();
        sync(&fake, &store, Budget::default(), &[]).await;
        let gaps = serde_json::to_string(&*store.saved_gaps.lock().unwrap()).unwrap();
        assert!(gaps.contains("PRIVATE-GAP") && !gaps.contains("DO-NOT-PERSIST"));
    }

    #[tokio::test]
    async fn a_run_another_holds_is_not_searched() {
        let fake = Fake::default();
        let store = Memory {
            acquired: false,
            ..Memory::new()
        };
        let done = sync(&fake, &store, Budget::default(), &[]).await;
        assert!(fake.searches.lock().unwrap().is_empty());
        assert_eq!(done.coverage.status, "running");
    }
}
