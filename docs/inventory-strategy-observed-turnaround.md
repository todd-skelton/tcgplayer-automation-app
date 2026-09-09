# Inventory Strategy observed turnaround

Inventory Strategy keeps a saved manual turnaround for each seller and optional product line. Observed mode changes only the strategy comparison inputs. It never changes a pricing hurdle, activates a forecast correction, or publishes a price.

The observed estimator is deliberately small. It reads the immutable `pooled-proceeds/v2` report, uses completed USD samples whose sales occurred in the report's trailing 90-day cohort, and calculates:

- typical: completed dollar-weighted mean turnaround;
- slower: completed dollar-weighted p90 turnaround, presented as a scenario rather than a confidence bound.

Automatic selection requires a report no more than 24 hours old and a complete `LastThreeMonths` Seller Portal API scan finished within 24 hours. The scan must satisfy the shipped pagination contract: a reported total, an offset and distinct observed-order count reaching that total, and no missing-detail gaps. Detail rows fetched during that particular run may be zero when previously verified details are reused. Observed order minimum and maximum dates describe the orders found; they are not coverage boundaries.

The cohort needs at least 20 distinct completed replacement purchases whose sale dates span at least 14 days. At least 80% of completed dollars must have actual proceeds, actual cost, and non-inferred funding evidence. Automatic selection is withheld while any known USD money is waiting, unallocated, unresolved, unsupported, reserved, withdrawn, or otherwise incomplete. Typed orphan or above-current-cost purchase funding at or before the report cutoff also withholds selection in its own currency; future-dated funding stays descriptive until its effective date. Missing or malformed typed funding authority makes an older saved v2 report ineligible without rewriting it. Recent or undated unknown proceeds and applicable unknown-cost receipts also withhold selection. Older dated unknowns stay visible without permanently preventing a supported forward cohort.

A product-line cohort means pooled proceeds attributed to replacement receipts carrying that immutable receipt product-line ID. It does not mean that the sold cards came from the same line or that the replacement was physically linked by FIFO. A line with only sparse evidence may visibly use an eligible seller-wide estimate. A line with stale, incomplete, unknown-cost, or poor-provenance evidence keeps its manual fallback.

The capital-cycle output remains a simplified full-reinvestment comparison. Typical, slower, and effective turnaround scenarios use the same displayed sell horizon so their cycle days and modeled profit per day can be compared. The calculation does not measure portfolio growth or simulate partial cash flows.

## G0: smaller shape chosen

The implementation adds one seller/product-line settings table, adds only the eligibility metadata needed to the existing immutable report, and keeps the estimator pure at the Inventory Strategy boundary.

The following were intentionally not built:

- a second order, receipt, funding, or allocation ledger, because the existing immutable report already owns that evidence;
- a survival estimator, because automatic selection is withheld until known money is complete;
- a partial-cash-flow or bank-balance simulation, because this comparison remains a full-reinvestment model;
- another scheduler, cache, or event system, because the existing report rebuild and source fingerprint already invalidate corrections;
- pricing or forecast writes, because turnaround settings are reporting inputs only;
- a persisted sell-horizon setting, because the existing active horizon or the displayed 20-day comparison is sufficient.
