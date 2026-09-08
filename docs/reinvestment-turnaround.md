# Reinvestment turnaround

The Inventory Strategy reinvestment report estimates when reusable seller proceeds become newly published replacement inventory. It is a financial pooled attribution. It does not identify the physical card that replaced a sold card, prove payout availability, or reproduce inventory FIFO.

## Pooled attribution rule

The rule version is `pooled-proceeds/v1`. Money is isolated by seller and currency and all arithmetic uses whole cents. Positive reusable proceeds use the current order economics rules, including verified provider net, refunds, postage, and other expenses. Orders with incomplete financial evidence remain excluded and lower coverage. Negative proceeds reduce money already available; an uncovered negative balance must be settled by the next source of cash before that cash can fund a purchase.

At each purchase, opening cash, outside contributions, and released outside cash pay first. Eligible sale proceeds then pay oldest first. Reserves and withdrawals make sale proceeds unavailable before outside cash. A reserve retains the source and age of the held money, and a release can restore only money that was actually reserved. This conservative priority avoids claiming reinvestment when outside funding can explain the cost. When only part of one purchase is sale funded, those cents are apportioned across its publication tranches in proportion to current cost. Remainders are assigned once across the whole funding group so repeated one-cent sources cannot overfill the first tranche.

Current `purchase_funding` entries are timing and amount evidence for their matching current purchase cost. They do not add another cost or another cash balance. If they cover only part of a cost, the rest stays unresolved. Otherwise the current purchase date supplies the funding cutoff. A date-only purchase or funding record is treated as the start of that UTC date, before timestamped sales on the same date. A later sale can never fund an earlier known purchase.

When neither purchase nor funding timing exists, each cost tranche uses its first confirmed supported publication time. Waiting quantity uses the report cutoff. Those samples are labeled `sale_to_publication_inference`; they do not claim observed cash conversion.

Cost is taken only from allocations attached to the current purchase-cost version. Each receipt cost is split by supported publication quantity with exact remainder allocation. When sale or explicit funding covers only part of a purchase, attributed cents are divided across the purchase's remaining cost tranches proportionally, with stable remainder ordering and per-tranche cost capacities preserved across funding dates. A receipt link's `live_at` is the successful-publication clock. Pending, failed, ambiguous, unlinked, and unpublished quantities remain waiting. A future publication stays waiting until the effective cutoff.

Events after the report's exact effective cutoff do not enter balances or coverage and appear as excluded future evidence. The normal UI cutoff is the start of the current UTC hour, which bounds immutable rebuild growth while still rebuilding within the hour whenever the complete source fingerprint changes.

## Metrics and persistence

Completed mean, median, and p90 are weighted by attributed cents. Waiting and unallocated ages are also dollar weighted and shown with their oldest age. Completion coverage is completed attributed money divided by all attributed purchase money. Percentage reinvested is completed plus waiting attributed sale proceeds divided by all positive eligible proceeds. Its denominator includes money later reserved, withdrawn, or offset by negative proceeds.

Every rebuild reads a serialized repeatable snapshot with explicit 10,000-row completeness fences for orders, postage, expenses, costs, publications, funding, and unknown-cost receipts. The full current source identities, rule, and exact cutoff form the source fingerprint. Identical sources, rule, and cutoff reuse the immutable rebuild. A changed current order, refund, cost, funding adjustment, or receipt publication creates a new rebuild and atomically advances the seller's current pointer. Previous reports and partial allocation rows stay immutable for audit. `recorded_at` is not treated as the historical occurrence time; reports describe a current-corrected view.
