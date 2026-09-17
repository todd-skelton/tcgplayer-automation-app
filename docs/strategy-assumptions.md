# Strategy assumptions

Inventory Economics and Inventory Strategy exist to give a directional sense of margin and turnaround, not audited financials. Where order or lot evidence is missing, the app fills the gap with the assumption that is normally true, labels the result estimated, and moves on. Nothing in this list blocks a report. The assumptions live in `app/features/inventory-economics/domain/strategyAssumptions.ts` (`STRATEGY_ASSUMPTIONS`).

## Assumptions

1. Refunds. The Seller Portal reports an empty refund status and no refund records for unrefunded orders; that is treated as no refund.
2. Refund settlement. A refund without a recorded settlement entry reduces net proceeds by the refund's share of the gross order, so fees are treated as refunded proportionally. A canceled order returns nothing. Recorded settlements still take precedence.
3. Postage. An order without a purchased label is assumed to have cost the seller's median purchased postage; if nothing has been purchased yet, the default first-class rate (`DEFAULT_POSTAGE_CENTS`). Canceled orders that never shipped carry no postage. Purchased postage still takes precedence.
4. Acquisition cost. Every lot is costed by the estimated purchase cost rule (see `docs/estimated-purchase-costs.md`). A lot without an intake market price, such as opening-balance stock, is valued at the SKU's TCG market price for the week the seller's inventory was first observed, else its current market price. Migration 047 gathers opening-balance lots into one `opening_balance` batch per seller so the rule can reach them.
5. Funding. Every purchase is funded on its purchase date (the earliest intake date of its batch). Funding entries remain available for recording outside cash, but nothing requires them.

## Observed turnaround

Observed mode only falls back to the manual turnaround when the evidence cannot be read at all: no report, a stale report (over 24 hours), a report for another seller or rule version, mixed currencies, or a cohort below 20 completed purchases spanning 14 sale days. Everything else that used to withhold selection (incomplete order scans, waiting or unallocated proceeds, unsupported funding, unknown proceeds or cost on some orders, estimated provenance) is reported as a note on the evidence and does not block. Confidence is high at 40 or more completed purchases, medium at 20, low below that.