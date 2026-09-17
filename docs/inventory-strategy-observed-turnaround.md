# Inventory Strategy observed turnaround

Inventory Strategy keeps a saved turnaround source and manual days for each seller; the page edits the seller-wide setting, and product-line rows in the settings table are no longer edited from the UI. Observed mode changes only the strategy comparison inputs. It never changes a pricing hurdle or publishes a price.

The observed estimator is deliberately small. It reads the immutable `pooled-proceeds/v2` report, uses completed USD samples whose sales occurred in the report's trailing 90-day cohort, and calculates:

- typical: completed dollar-weighted mean turnaround;
- slower: completed dollar-weighted p90 turnaround, presented as a scenario rather than a confidence bound.

Automatic selection requires a report no more than 24 hours old for the same seller and rule version, a single USD proceeds pool, and a cohort of at least 5 distinct completed replacement purchases whose sale dates span at least 14 days. Order-scan completeness, waiting or unallocated proceeds, unsupported funding, unknown proceeds or cost on some orders, and estimated provenance are reported as notes on the evidence and do not withhold selection; see `docs/strategy-assumptions.md` for the assumptions that fill those gaps.
A product-line cohort means pooled proceeds attributed to replacement receipts carrying that immutable receipt product-line ID. It does not mean that the sold cards came from the same line or that the replacement was physically linked by FIFO. A line with only sparse evidence may visibly use an eligible seller-wide estimate. A line with stale, incomplete, unknown-cost, or poor-provenance evidence keeps its manual fallback.

The capital-cycle output remains a simplified full-reinvestment comparison that feeds the verdict's best-hurdle ranking. The page shows the typical and slower days, the evidence count and confidence, waiting proceeds, and the effective turnaround in use. The calculation does not measure portfolio growth or simulate partial cash flows.

## G0: smaller shape chosen

The implementation adds one seller/product-line settings table, adds only the eligibility metadata needed to the existing immutable report, and keeps the estimator pure at the Inventory Strategy boundary.

The following were intentionally not built:

- a second order, receipt, funding, or allocation ledger, because the existing immutable report already owns that evidence;
- a survival estimator, because completed cycles are enough for a directional typical and p90;
- a partial-cash-flow or bank-balance simulation, because this comparison remains a full-reinvestment model;
- another scheduler, cache, or event system, because the existing report rebuild and source fingerprint already invalidate corrections;
- pricing or forecast writes, because turnaround settings are reporting inputs only;
- a persisted sell-horizon setting, because the existing active horizon or the displayed 20-day comparison is sufficient.
