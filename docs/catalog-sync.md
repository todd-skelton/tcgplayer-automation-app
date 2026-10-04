# Sync new products

Data Management's **Sync new products** brings one product line up to date with TCGplayer without walking the whole catalog. Use it after a set releases or when promo sets grow.

## How it decides what to fetch

1. Refresh the product line's set list from TCGplayer (one request).
2. Read every set's product count from the set name aggregation that comes with a single TCGplayer search request.
3. Compare each count with the count recorded at the set's last verified sync, and with the products stored locally in that set. Stored products only count when their details and SKUs are stored under the same set.
4. Search sets that have never been verified, sets whose listed count moved since the last verified sync, and sets with fewer stored products than listed. The first sync of a product line therefore searches every set once.
5. In those sets, fetch details and SKUs only for products that are missing, have no SKUs, or are stored under another set. File each product under the set its details report.
6. Record the set's listed count as verified only when every listed product is stored in the set and the search returned every listed product. Unverified sets are retried on the next sync and reported in the result.

Matching stored and listed counts are not trusted on their own. A stale stored row (a product TCGplayer no longer lists in the set) can offset a listed product that was never stored, so the counts match while a product is missing. Verifying each set once, then comparing against the verified count, closes that gap.

## Limits

- Counts are net. If a verified set gains one product and loses another between syncs, its listed count does not move and the sync does not notice.
- New SKUs on products that are already stored are not detected. Use **Repair one product**.
- Stored products that TCGplayer no longer lists are reported through the counts but never deleted.
- Sets that TCGplayer search lists under a URL name missing from its set list are reported and skipped.

## Verification

- `npm test` covers the sync decisions and a fake catalog run: a new set, a growing promo set, a misfiled product, a product whose details fail, a short search, and a failing set.
- Migration 051 adds `category_set_syncs` and is additive. Rolling back the code leaves the table unused.
