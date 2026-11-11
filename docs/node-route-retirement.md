# Retiring the Node JSON routes

The Node app was removed after release 8 (`docs/prod-cutover.md`); it is in the history at 0587ed02e, the master that release 8 shipped. This page records how its routes were retired.

The Corten app serves every screen, and relays each `/api/...` path it has not ported to the Node
app (`src/app.rs`, `LegacyApiRoute`). Decision (2026-11-03): port only the routes a Corten screen,
a Rust worker or another caller needs, and retire the rest with the Node app.

## What still calls a relayed route

Checked on `codex/corten-port` at a59d7e712:

1. No Corten screen, form, component or static script requests any route below. They appear in
   `src` only in doc comments and tests.
2. No Rust worker calls one: the workers call the shared database and TCGplayer directly.
3. The Node workers (`build/workers/*.js` in `docker-compose.prod.yml`) import services in-process;
   none makes an HTTP request to the app.
4. The only `fetch` calls of these routes in `app/` are the Node screens' client code
   (`pricingService.ts` posts `/api/suggested-price`, `shippingIntakeHistory.ts` posts
   `/api/shipping-export/intake-history`), and the Node app no longer draws a screen.

So each route below answers only a caller outside the app (a script or a bookmark), if any.

## Ported (served by Corten)

`batch_pricer`: `/api/inventory-batches` and its `import-seller`, `import-csv`, `/:batchNumber`,
`items`, `results`, `publications`, `pricing-jobs` and `pricing-stream`.
`/api/forecast-calibration`, `/api/inventory-economics`, `/api/inventory-fifo`,
`/api/inventory-history-diagnostics`, `/api/inventory-intake-runs`,
`/api/inventory-opening-balance`, `/api/inventory-publication-settings`,
`/api/inventory-publication-health`, `/api/pricing-config`, `/api/pull-sheet-lookup`,
`/api/seller-order-history`, `/api/shipping-export/intake-history`, `/api/shipping-thresholds`,
`/api/slab-comp-decisions`, `/api/slab-evidence`, `/api/slab-identities`, `/api/slab-inventory`
and `/api/slab-recommendations`.

Their answers are checked against Node's (`crate::api::tests::answers_as_node`) from recordings
in `tests/fixtures/node/api`, made by `scripts/parity/record-node-answers.ts`.

## To retire with the Node app (31)

Each one's work is done by a Corten screen's own action or loader, named here, so nothing is lost.

1. `/api/inventory-reinvestment-turnaround`, `/api/inventory-strategy-analysis`: the strategy
   screen (`inventory_strategy`).
2. `/api/slab-outcomes`, `/api/slab-maintenance`, `/api/slab-publications`,
   `/api/slab-publication-previews`, `/api/slab-supply`, `/api/slab-workspace`,
   `/api/slab-comp-review`: the slab pricing screens (`slab_pricing`).
3. `/api/continuous-pricing`: `continuous_pricing`.
4. `/api/data-management`: `data_management`.
5. `/api/suggested-price`, `/api/price-points`, `/api/validate-skus`: the batch pricer and
   intake screens price through `pricing` directly.
6. `/api/seller-inventory`: the batch pricer's seller snapshot (`batch_pricer`).
7. `/api/product-price-matrix`, `/api/product-price-matrix/products`: `product_price_matrix`.
8. `/api/inventory/product-lines`, `/api/inventory/sets`, `/api/inventory/skus`,
   `/api/inventory/skus-by-set`, `/api/inventory/skus-by-card-number`: the intake screen's catalog
   lookups (`inventory_intake::catalog`).
9. `/api/pending-inventory`: `inventory_intake::pending`.
10. `/api/shipping-export/postages`, `batch-labels`, `postage-lookups`, `tcgplayer-orders`,
    `tcgplayer-tracking`, `tcgplayer-shipped-messages`, `pull-sheet-export`,
    `packing-slips-export`: the shipping workflow (`shipping_export`).

## When

The relay stays until the Node workers are retired too, since the Node app is still deployed for
them. Then the relay, `LEGACY_ORIGIN` and `app/routes.ts` go together, in release 8
(`codex/release-8-drop-node`; `docs/prod-cutover.md`): each route above is then the API's 404, in
the shape `{"error": ..}` the API answers every failure in. Production changes wait for Todd's
approval.
