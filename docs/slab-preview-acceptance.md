# Slab preview acceptance and performance

Validated September 6, 2026 UTC. This report covers inventory import, evidence review, supply context and immutable price-change previews. Live publication and continuous pricing are not enabled and are not validated by these results. Issues #24, #29–#33 remain open where their native-data or live-workflow criteria are unmet.

## Sample and coverage

The committed `evaluation/fixtures/pokebash-preview-sample.json` contains 50 historical public listing titles/asks and observed search-row counts, sanitized from the user's local evaluation. It preserves PSA, CGC labels, SGC, Japanese, vintage and One Piece cases. Two separate Galarian Zapdos listings share one research query: 50 listing identities, 49 queries. Eight searches had no visible sold results. The 800 visible search rows include the repeated query and are **not** 800 accepted comparable transactions.

Certificates and verified card variants are not available for these 50 titles. The fixture cannot establish confirmed identity coverage, accepted-comp precision, pricing error or review time. Those metrics remain null. Import tests deliberately assign placeholder quantity/format and keep every certificate unresolved; they do not infer identity or discard unsupported graders. Existing certificate, screening, eleven-sale deduplication and cross-grade fixtures test their respective contracts separately.

## Measured preview performance

Machine-local PostgreSQL 16 development schema, Node 24.15 on Windows; 30 sequential samples after warm-up. See [raw feature measurements](slab-preview-benchmark.json).

| Operation                                                                   |     p50 |     p95 | Pool queries per sample |
| --------------------------------------------------------------------------- | ------: | ------: | ----------------------: |
| Read 50 listings in two 25-row pages                                        |  5.2 ms |  6.1 ms |                       4 |
| Re-request 50 synthetic slabs / 10 fresh evidence groups and check for work | 10.6 ms | 13.2 ms |                       5 |
| Read all ten cached evidence revisions                                      |  8.3 ms | 13.7 ms |                      10 |
| Read 25 rows from 5,000-row inventory                                       |  7.1 ms |  8.9 ms |                       2 |

The 50-row import took 85 ms; 5,000 synthetic rows took 591 ms. The fixture-backed cold evidence workload completed in 164 ms with ten provider workflows; warm repetition issued zero provider requests. No real provider/network latency is included. The isolated workload occupied 5.0 MiB of PostgreSQL table/index storage. Its final Node process RSS sample was 130 MiB, not a peak-memory or production-server measurement. Query counts instrument pool queries during the named read workloads, not transaction-client queries during import.

Supply history has a separate 203-scan/50-listing integration check: 200 recent scans plus one retained scan leave 10,050 small references and 51 listing bodies after one observed price change. Latest/pinned evidence survives retention. See [supply behavior and reproduction](slab-supply-context.md).

## Baseline comparison

Baseline commit `00d7bb3e2` predates slab integration. The current production build is commit `1da700c6c` (through PR #47), with no provider credentials. Both use the same Docker Node 20.20.2 image and fresh databases. Fifty HTTP samples per existing route alternate baseline/current order after five warm-up requests. This measures empty-state rendering, not production job contention or complete pricing sessions. See [raw HTTP measurements](slab-preview-http.json).

| Existing route | Baseline p95 | Current p95 |
| -------------- | -----------: | ----------: |
| Dashboard      |      44.9 ms |     50.4 ms |
| CSV pricer     |      37.5 ms |     37.8 ms |
| Batch pricer   |      27.3 ms |     28.2 ms |

The new slab page rendered at p95 38.0 ms, connections at 34.4 ms and empty inventory API at 9.0 ms. A one-time Docker RSS sample after the run was 219 MiB baseline / 156 MiB current; garbage collection makes this unsuitable for claiming a memory improvement.

The existing CSV and batch-pricer static assets grew by 395 and 1,076 gzip bytes respectively, including shared navigation and route-manifest metadata. Neither loads slab implementation chunks. The three existing TCGplayer worker files have exactly the same byte sizes. The optional slab evidence worker is 61,609 bytes. The slab page's full static dependency set is 377,705 gzip bytes, including existing React/MUI/grid dependencies. Its lazy comp, supply and publication panels add 7,117 / 3,341 / 2,087 gzip bytes respectively, excluding shared imports. See [raw bundle measurements](slab-preview-bundles.json).

Structural gates enforce zero remote calls for the fixture cache workload, one refresh per evidence group, bounded inventory pages and no slab implementation modules on unrelated routes. The bundle comparison enforces a 4 KiB compressed growth budget for existing route navigation/manifest changes. Based on this baseline, investigate future repeatable p95 increases above 20% plus 5 ms on existing empty-state routes, or local warm inventory p95 above 50 ms. Timing thresholds are advisory on a shared development machine; they do not replace a controlled production comparison.

## Build, migration and recovery checks

The measurements below describe the preview-stage build through PR #47. Later checks cover [publication execution](slab-publication-review.md), [opt-in evidence maintenance](slab-evidence-maintenance.md), and a [33-migration backup/restore rehearsal](slab-recovery.md). The original performance figures have not been relabeled as measurements of those later stages.

Host typecheck, offline test suite, production/worker build and targeted PostgreSQL integrations pass, including existing TCGplayer pricing/publication regression tests. Docker `npm ci` and production build pass on Node 20; existing MUI build warnings remain. No new runtime dependencies were added across these merged slab changes. No browser runtime is bundled.

A fresh isolated Docker database applied all 31 migrations and served the slab and existing routes with zero provider connections and zero evidence jobs. Rerunning migrations was idempotent. A second isolated database upgraded from migrations 1–23 to 1–31 and retained a seeded existing marker row. These checks are not a production-data restore rehearsal. Expanded Docker exclusions keep `.env*`, research captures and Codex artifacts out of the build context; runtime inspection found no local environment or research files. Temporary validation containers/databases are removed after evaluation; existing development and production containers are untouched.

Before deploying, back up the actual PostgreSQL database and verify restore into a separate database. Migrations 024–031 add feature-owned tables/indexes and a supply-reference column; they do not rewrite TCGplayer data. Restore supply scans, evidence references, recommendations and previews together. For application rollback to the pre-slab build, leave additive slab tables intact; do not drop referenced evidence to imitate a price rollback. No production deployment or live eBay write was performed in this evaluation.

Connections, reconnect/cancellation and cache retention are documented in [evidence cache operations](ebay-slab-evidence-cache.md), [slab review](slab-pricing-page.md) and [publication review](slab-publication-review.md). Native session checks were completed for Alt/eBay Research earlier; expired/absent session behavior is covered offline. Seller OAuth remains blocked by production keyset activation shared with another application.

## Reproduction

Run `npm test`, `npm run typecheck`, `npm run build` and `npm run benchmark:slab-preview` in the development checkout. The benchmark explicitly accepts only localhost:5433/tcgplayer_automation and creates/removes a disposable schema. It writes the feature JSON report and prohibits network fetches.

Build the baseline and current Docker images from separate source directories. Start them against separate **disposable** PostgreSQL databases, with no provider credentials, bound to local ports. Copy each image's `/app/build` directory to local baseline/current build directories, then run:

```sh
node app/features/ebay-slab-pricing/evaluation/compare-slab-preview-builds.mjs BASELINE_BUILD CURRENT_BUILD
node app/features/ebay-slab-pricing/evaluation/benchmark-slab-http.mjs http://127.0.0.1:BASELINE_PORT http://127.0.0.1:CURRENT_PORT
```

These commands write the bundle and HTTP JSON reports. Keep build/runtime versions and load comparable. Do not point validation at production. The remaining acceptance work is verified seller import, complete native publication/reconciliation/restore, outcome/exposure validation, approved model cohorts and opt-in scheduling with live request/write budgets and contention measurements. The report does not close #33 or authorize those stages automatically.
