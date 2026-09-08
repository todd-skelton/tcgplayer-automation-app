# Inventory selling history

Inventory Strategy measures marketplace exposure from the shared inventory
history. It does not infer listing time from receipt intake, opening-balance
cutoffs, price changes, or the current pricing model.

## Cohorts and outcomes

A cohort is the quantity on one receipt lot when its first successful
marketplace publication is confirmed. Partial batch success produces separate
cohorts only where the publication producer already has separate receipt lots
and publication items. A retry or repricing operation cannot change the saved
publication time or forecast evidence.

Current FIFO revision allocations supply sale outcomes. A sale that spans two
publication lots retains the quantity and listed duration from each lot.
Canceled orders are removals, not sales. Physical restocks and order quantity
corrections restore FIFO eligibility, but their `available_at` value is not
marketplace publication evidence; those quantities have an unknown listed date
until a later publication is explicitly confirmed. Opening inventory is also
date-unknown.

The report defaults to a rolling 180-day publication window. The user can
select 90, 365, or 730 days and can narrow the report to one product line.
Aggregate calculations read at most 20,000 cohorts and 40,000 outcomes within
that selected scope; if either bound is reached, the report preserves the scope
controls and asks the user to narrow instead of silently calculating from a
partial population. Confirmed quantity before the selected window remains
visible in coverage. Inspectable detail is paged independently at 50 cohorts
per page.

## Statistics

The observation cutoff is the completion time of the latest complete,
gap-free seller order scan. A complete order scan lets new confirmed
publication cohorts accumulate without waiting for another full inventory
export. Publications and returned quantities after that cutoff wait for the
next scan and appear in coverage rather than entering the current cohort.
Remaining quantities are labeled as ledger-expected; their
presence is uncertain when the latest complete inventory observation is older
than the cutoff, a FIFO projection is pending or held, or a removal is
unresolved.

Sell-through at 7, 30, 60, and 90 days includes only cohorts old enough to have
the full horizon observed. Every unit in an eligible cohort stays in the
denominator, including unsold and removed units. A pending or held FIFO outcome
makes the affected horizon unavailable; it is never treated as a silent
failure.

Median and p90 days to sale use quantity-weighted Kaplan-Meier risk sets, with
remaining units right-censored at the observation cutoff. A percentile is
unavailable until the survival curve reaches it. Known stock removals are a
competing outcome rather than ordinary censoring, so the report abstains from
full-cohort percentiles whenever removals are present. The sold-only average is
labeled for its sold population and is not presented as expected wait for all
inventory. Full-cohort percentiles also remain unavailable when remaining
quantity has no inventory-presence evidence through the report cutoff.

## Forecast evidence and coverage

Forward publication planning copies only forecast, pricing policy, and model
fields supplied by the exact pricing candidate. Receipt activation binds that
immutable snapshot to the confirmed quantity. Historical positive-quantity
publication evidence is backfilled in batches of at most 500 only when batch,
SKU, result time, candidate key, and published price match an existing
successful pricing result. Price-only repricing rows remain unknown. Unsupported
rows also remain `unknown`; current prices and models are never used to
reconstruct an old forecast.

Legacy publications without receipt links remain outside selling cohorts.
Inventory Strategy reports their quantity and the subset with preserved exact
forecast evidence, alongside unknown opening quantity, order freshness and
gaps, pending or held FIFO quantities, and unresolved removals. Cost and price
coverage do not gate listed-date metrics.

Unresolved removal coverage reuses the shared FIFO reconciliation result. Only
the negative residual between an observed inventory change and its expected
publication, sale, restock, and correction flow is a removal; an explained
inventory decrease is not reclassified by this report.
