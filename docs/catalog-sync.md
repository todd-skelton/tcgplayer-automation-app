# Sync new products

Data Management's **Sync new products** brings one product line up to date with TCGplayer without walking the whole catalog. Use it after a set releases or when promo sets grow.

## How it decides what to fetch

1. Refresh the product line's set list from TCGplayer (one request).
2. Read every set's product count from the set name aggregation that comes with a single TCGplayer search request.
3. Compare each count with the products stored locally in that set, which are only counted when their details and SKUs are stored under the same set, and with the count recorded at the set's last verified sync.
4. Search only the sets where TCGplayer lists more products than are stored, or where the listed count moved since the last verified sync.
5. In those sets, fetch details and SKUs only for products that are missing, have no SKUs, or are stored under another set. File each product under the set its details report.
6. Record the set's listed count as verified only when every listed product is stored in the set and the search returned every listed product. Unverified sets are retried on the next sync and reported in the result.

The verified count matters for sets that hold more stored rows than TCGplayer lists, such as products that were removed or moved. Their stored count can stay above the listed count indefinitely, which would otherwise hide new products added to the set.

## Limits

- Counts are net. If a set gains one product and loses another between syncs, the counts match and the sync does not notice.
- New SKUs on products that are already stored are not detected. Use **Repair one product**.
- Stored products that TCGplayer no longer lists are reported through the counts but never deleted.
- Sets that TCGplayer search lists under a URL name missing from its set list are reported and skipped.

## Verification

- `npm test` covers the sync decisions and a fake catalog run: a new set, a growing promo set, a misfiled product, a product whose details fail, a short search, and a failing set.
- Migration 051 adds `category_set_syncs` and is additive. Rolling back the code leaves the table unused.
