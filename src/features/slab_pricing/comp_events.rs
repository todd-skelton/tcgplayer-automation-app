//! The sale events a recommendation rests on (`reconcileSaleEvents` in `compEvents.ts`, and
//! `collectDirectComps`): the copies of one sale across revisions joined, an Alt sale and the eBay
//! sale it reports joined when their grades agree, each event screened against the slab, and its
//! price taken from its best accepted source when nothing about it is contradicted; otherwise why
//! it needs review or was rejected.
use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;
use serde_json::{Value, json};

use super::{
    screening::{self, Decision, Reference, Sale, SaleWindow, Target},
    valuation::{CompReference, DirectComp, Policy},
};
use crate::features::{
    inventory_economics::ledger::fingerprint::{js_float, stable_json},
    inventory_strategy::collate,
};

/// A sale saved in an evidence revision (`SaleReference`).
#[derive(Clone, Debug)]
pub struct Saved {
    pub revision_id: String,
    /// When the revision was fetched, as `toISOString` writes it.
    pub fetched_at: String,
    pub window: SaleWindow,
    pub sale: Sale,
    /// The sale as saved, which tells two copies of it apart.
    pub raw: Value,
}

impl Saved {
    fn reference(&self) -> Reference<'_> {
        Reference {
            revision_id: &self.revision_id,
            fetched_at: &self.fetched_at,
            window: self.window.clone(),
            sale: &self.sale,
        }
    }

    fn cited(&self) -> CompReference {
        CompReference {
            revision_id: self.revision_id.clone(),
            provider: self.sale.provider.clone(),
            provider_id: self.sale.provider_id.clone(),
            date: self.sale.date.clone(),
        }
    }

    /// `JSON.stringify([revisionId, provider, providerId, date])`, which a decision is found by.
    fn decision_key(&self) -> String {
        decision_key(
            &self.revision_id,
            &self.sale.provider,
            &self.sale.provider_id,
            self.sale.date.as_deref(),
        )
    }
}

fn decision_key(revision: &str, provider: &str, provider_id: &str, date: Option<&str>) -> String {
    json!([revision, provider, provider_id, date]).to_string()
}

/// What JavaScript reads as true of an optional string.
fn filled(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

fn currency_of(sale: &Sale) -> Option<&str> {
    filled(sale.price.as_ref().and_then(|p| p.currency.as_deref()))
}

/// One sale event (`CompEvent`): its copies, newest first, the one whose price is reported, and
/// what makes it uncertain.
#[derive(Debug)]
struct Event {
    key: String,
    references: Vec<usize>,
    representative: usize,
    kind: &'static str,
    reasons: Vec<String>,
}

fn add(reasons: &mut Vec<String>, reason: &str) {
    if !reasons.iter().any(|r| r == reason) {
        reasons.push(reason.to_owned());
    }
}

/// `event`: the copies `references` of one sale, as one event.
fn event(all: &[Saved], key: String, mut references: Vec<usize>) -> Event {
    references.sort_by(|&a, &b| {
        collate::compare(&all[b].fetched_at, &all[a].fetched_at)
            .then_with(|| collate::compare(&all[a].revision_id, &all[b].revision_id))
    });
    // For a matched eBay sale, prefer eBay's native reported item amount to an undated converted field.
    let representative = references
        .iter()
        .copied()
        .find(|&r| all[r].sale.provider == "ebayResearch" && currency_of(&all[r].sale).is_some())
        .or_else(|| {
            references
                .iter()
                .copied()
                .find(|&r| currency_of(&all[r].sale).is_some())
        })
        .unwrap_or(references[0]);
    let mut reasons = Vec::new();
    let known: HashSet<String> = references
        .iter()
        .filter_map(|&r| {
            let price = all[r].sale.price.as_ref()?;
            let currency = filled(price.currency.as_deref())?;
            Some(format!("{currency}:{}", js_float(price.amount)))
        })
        .collect();
    if known.len() > 1 {
        add(&mut reasons, "source-price-disagreement");
    }
    if let Some(reported) = all[representative].sale.price.as_ref()
        && let Some(currency) = filled(reported.currency.as_deref())
    {
        let disagrees = references.iter().any(|&r| {
            all[r].sale.converted_price.as_ref().is_some_and(|c| {
                c.currency.as_deref() == Some(currency) && c.amount != reported.amount
            })
        });
        if disagrees {
            add(
                &mut reasons,
                "provider-conversion-disagrees-with-reported-price",
            );
        }
    }
    let single = references
        .iter()
        .any(|&r| all[r].sale.kind == "transaction" || all[r].sale.quantity == Some(1.0));
    let kind = if single {
        "single-sale"
    } else {
        "listing-average"
    };
    if !single {
        add(&mut reasons, "aggregate-is-not-an-independent-transaction");
    }
    Event {
        key,
        references,
        representative,
        kind,
        reasons,
    }
}

/// `sourceKey`: what makes two copies the same sale from the same source.
fn source_key(saved: &Saved) -> String {
    let sale = &saved.sale;
    let date = if sale.provider == "alt" {
        None
    } else {
        sale.date.as_deref()
    };
    let window = (sale.kind == "listing-average" && sale.quantity != Some(1.0))
        .then(|| json!([saved.window.from, saved.window.to]));
    json!([sale.provider, sale.provider_id, sale.kind, date, window]).to_string()
}

/// Entries by key, in the order each key was first seen, as a JavaScript `Map` keeps them.
fn group<T>(entries: impl IntoIterator<Item = (String, T)>) -> Vec<(String, Vec<T>)> {
    let mut groups: Vec<(String, Vec<T>)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (key, entry) in entries {
        match at.get(&key) {
            Some(&index) => groups[index].1.push(entry),
            None => {
                at.insert(key.clone(), groups.len());
                groups.push((key, vec![entry]));
            }
        }
    }
    groups
}

/// `reconcileSaleEvents`: the events of `all`, by key.
fn reconcile(all: &[Saved]) -> Vec<Event> {
    let copies = group(
        all.iter()
            .enumerate()
            .map(|(i, saved)| (source_key(saved), i)),
    );
    let mut events: Vec<Event> = copies
        .into_iter()
        .map(|(key, rows)| {
            // A copy saved twice in one revision is one copy; the last one stands, where the first was.
            let unique = group(
                rows.into_iter()
                    .map(|r| (stable_json(&json!([all[r].revision_id, all[r].raw])), r)),
            );
            let rows: Vec<usize> = unique
                .into_iter()
                .map(|(_, same)| same[same.len() - 1])
                .collect();
            event(all, key, rows)
        })
        .collect();
    let buckets = group(events.iter().enumerate().filter_map(|(i, entry)| {
        let sale = &all[entry.representative].sale;
        let item = filled(sale.source_item_id.as_deref())?;
        let date = filled(sale.date.as_deref())?;
        (entry.kind == "single-sale").then(|| (json!([item, date]).to_string(), i))
    }));
    let mut replaced = HashSet::new();
    let mut joined = Vec::new();
    for (key, bucket) in buckets {
        let by = |provider: &str| -> Vec<usize> {
            bucket
                .iter()
                .copied()
                .filter(|&i| all[events[i].representative].sale.provider == provider)
                .collect()
        };
        let (alt, ebay) = (by("alt"), by("ebayResearch"));
        let same = match (alt.as_slice(), ebay.as_slice()) {
            ([a], [e]) => {
                let (a, e) = (
                    &all[events[*a].representative].sale,
                    &all[events[*e].representative].sale,
                );
                let grade = screening::sale_grade(a);
                let (ca, ce) = (
                    filled(a.certificate_number.as_deref()),
                    filled(e.certificate_number.as_deref()),
                );
                grade.is_some()
                    && grade == screening::sale_grade(e)
                    && (ca.is_none() || ce.is_none() || ca == ce)
            }
            _ => false,
        };
        if same {
            replaced.extend([alt[0], ebay[0]]);
            let references = [&events[alt[0]].references, &events[ebay[0]].references]
                .into_iter()
                .flatten()
                .copied()
                .collect();
            joined.push(event(all, format!("ebay-event:{key}"), references));
        } else if !alt.is_empty() && !ebay.is_empty() {
            for i in bucket {
                events[i]
                    .reasons
                    .push("possible-duplicate-event-requires-review".to_owned());
            }
        }
    }
    let mut result: Vec<Event> = events
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !replaced.contains(i))
        .map(|(_, entry)| entry)
        .chain(joined)
        .collect();
    let individual: HashSet<&str> = result
        .iter()
        .filter(|entry| entry.kind == "single-sale")
        .filter_map(|entry| filled(all[entry.representative].sale.source_item_id.as_deref()))
        .collect();
    for entry in &mut result {
        let item = all[entry.representative].sale.source_item_id.as_deref();
        if entry.kind == "listing-average" && item.is_some_and(|i| individual.contains(i)) {
            entry
                .reasons
                .push("aggregate-may-overlap-individual-sales".to_owned());
        }
    }
    result.sort_by(|a, b| collate::compare(&a.key, &b.key));
    result
}

/// An event that is not a comp (`CompDisposition`): `needs-review` or `rejected`, and why.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Disposition {
    pub key: String,
    pub status: &'static str,
    pub reasons: Vec<String>,
    pub references: Vec<CompReference>,
}

/// The comps, the events that are not, and how many of those need review or were rejected.
#[derive(Debug)]
pub struct Direct {
    pub comps: Vec<DirectComp>,
    pub dispositions: Vec<Disposition>,
    pub uncertain: usize,
    pub rejected: usize,
    pub event_warnings: Vec<String>,
}

/// Event reasons that keep an event's price out of the range.
const BLOCKING: [&str; 3] = [
    "possible-duplicate-event-requires-review",
    "aggregate-may-overlap-individual-sales",
    "source-price-disagreement",
];

/// `collectDirectComps`: the sales `all` as events, priced on the policy's basis, for the slab
/// `target` with the operator's decisions on them.
pub fn collect(
    all: &[Saved],
    target: &Target<'_>,
    decisions: &[Decision],
    policy: &Policy,
) -> Direct {
    let index: HashMap<String, &Decision> = decisions
        .iter()
        .map(|d| {
            (
                decision_key(
                    &d.revision_id,
                    &d.provider,
                    &d.provider_id,
                    d.date.as_deref(),
                ),
                d,
            )
        })
        .collect();
    let mut comps = Vec::new();
    let mut dispositions = Vec::new();
    let mut warnings = BTreeSet::new();
    let mut active = Vec::new();
    for saved in all {
        let excluded = index.get(&saved.decision_key()).is_some_and(|d| {
            d.decision == "exclude"
                && Some(d.valuation_group_key.as_str()) == target.valuation_group_key
                && !d.note.trim_matches(screening::js_space).is_empty()
        });
        if !excluded {
            active.push(saved.clone());
            continue;
        }
        let sale = &saved.sale;
        dispositions.push(Disposition {
            key: format!(
                "excluded:{}:{}:{}:{}",
                saved.revision_id,
                sale.provider,
                sale.provider_id,
                sale.date.as_deref().unwrap_or("null")
            ),
            status: "rejected",
            reasons: vec!["excluded-by-review".to_owned()],
            references: vec![saved.cited()],
        });
    }
    let item_only = policy.basis == "item-only";
    for event in reconcile(&active) {
        let screened: Vec<screening::Screened> = event
            .references
            .iter()
            .map(|&r| {
                let saved = &active[r];
                let decision = index.get(&saved.decision_key()).copied();
                screening::screen(&saved.reference(), target, &policy.currency, decision)
            })
            .collect();
        let price = |at: usize| {
            let row = &screened[at];
            if item_only {
                row.item_only
            } else {
                row.item_and_shipping
            }
        };
        let mut accepted: Vec<usize> = (0..screened.len())
            .filter(|&at| screened[at].status == "accepted")
            .collect();
        accepted.sort_by(|&a, &b| {
            let (a, b) = (&active[event.references[a]], &active[event.references[b]]);
            let ebay = |s: &Saved| s.sale.provider == "ebayResearch";
            ebay(b)
                .cmp(&ebay(a))
                .then_with(|| collate::compare(&b.fetched_at, &a.fetched_at))
        });
        let cited: Vec<CompReference> = event
            .references
            .iter()
            .map(|&r| active[r].cited())
            .collect();
        let selected = accepted.iter().copied().find(|&at| price(at).is_some());
        let blocked = event.reasons.iter().any(|r| BLOCKING.contains(&r.as_str()));
        let contradictory = screened.iter().any(|row| row.status == "rejected");
        match selected {
            Some(at) if !blocked && !contradictory => {
                let chosen = &active[event.references[at]];
                // Keep the price reference first, with all corroborating sources after it.
                let primary = cited
                    .iter()
                    .position(|c| {
                        c.revision_id == chosen.revision_id
                            && c.provider == chosen.sale.provider
                            && c.provider_id == chosen.sale.provider_id
                    })
                    .expect("the chosen sale is one of the event's");
                let mut references = cited;
                let first = references.remove(primary);
                references.insert(0, first);
                comps.push(DirectComp {
                    key: event.key,
                    date: chosen.sale.date.clone().unwrap_or_default(),
                    amount: price(at).expect("a price on the basis"),
                    currency: policy.currency.clone(),
                    kind: event.kind.to_owned(),
                    references,
                });
                warnings.extend(event.reasons);
            }
            _ => {
                let mut reasons: BTreeSet<String> = event.reasons.into_iter().collect();
                reasons.extend(
                    screened
                        .iter()
                        .flat_map(|row| row.reasons.iter().map(|r| r.code.clone())),
                );
                if !accepted.is_empty() && selected.is_none() {
                    reasons.insert("requested-price-basis-unresolved".to_owned());
                }
                let all_rejected = screened.iter().all(|row| row.status == "rejected");
                dispositions.push(Disposition {
                    key: event.key,
                    status: if contradictory && all_rejected {
                        "rejected"
                    } else {
                        "needs-review"
                    },
                    // Their codes are ASCII, so `sort()` puts them in byte order.
                    reasons: reasons.into_iter().collect(),
                    references: cited,
                });
            }
        }
    }
    let count = |status: &str| dispositions.iter().filter(|d| d.status == status).count();
    Direct {
        uncertain: count("needs-review"),
        rejected: count("rejected"),
        comps,
        event_warnings: warnings.into_iter().collect(),
        dispositions,
    }
}
