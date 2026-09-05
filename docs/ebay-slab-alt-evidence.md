# Alt sale and supply evidence

`createAltEvidenceForRun(signal)` composes the configured Alt transport with three small reads: `getSales(assetId, window, limitPerGrade = 16)`, `getSaleDetail(transactionId)`, and `getSupply(assetId)`. Create one instance per valuation run so detail deduplication and cancellation have the same lifetime. There is no global detail cache, polling loop, image download or additional service.

The all-grades history request uses `allGrades: true`, `showSkipped: true`, and `maxTransactionsPerGrade`. The adapter permits 1–16 records per grader/grade group. It filters the returned sample to the requested inclusive date window locally; it does not pretend a time-series filter constrains transactions. Missing dates remain review candidates. Coverage includes the requested window, min/max observed dates before local filtering, source count, cap and `complete: false`. Neither returned count nor observed date span establishes market-wide sales volume.

History, detailed sales and active listings use separate result types. No Alt estimated values or population counts enter these observations. Sale facts retain provider/source references, venue, date, format, original grade encoding and label, correction/skip flags, and monetary uncertainty. Unsafe source references are retained as text but are not exposed as clickable source URLs. eBay item IDs are extracted only from eBay URLs. Shared Alt identity-field functions keep certificate and sale parsing consistent.

Unknown shipping, fees and currency remain null. The history price has no verified currency field, so its currency remains unknown. A detail's explicit `usdAmount` is stored separately as a USD conversion; this does not establish the currency of shipping or fees. Shipping/buyer-premium inclusion flags remain unknown. Downstream screening must resolve these facts before comparing landed prices. Zero is retained only when the source explicitly supplies zero.

Details are lazy: reading history does not fetch individual transactions or images. Concurrent reads of the same normalized transaction ID share one promise. A run allows at most 32 distinct detail reads; completed results, including a missing detail, are memoized, while failures are removed so a later attempt can recover. All operations still obey the PostgreSQL provider lease/cooldown. Busy callers should reschedule rather than spin. The persisted evidence cache/jobs follow in #25.

Supply reads only `asset.activeListings` on Alt, reporting `scope: "alt-only"`, capture time and incomplete coverage. It retains listing/item identities, raw format/state, list-price value, dates and grading. Quantity, currency and ask-versus-bid semantics remain unknown unless separately verified; a list-price field is not treated as a confirmed executable ask. External/eBay supply is a separate provider. Population and estimated-value series are intentionally not requested. Typesense search is also unnecessary for these reads against resolved asset IDs.

## Verification on September 5, 2026

- Live native-fetch adapter reads reproduced 214 Ponyta and 194 Hitmonlee transactions at a cap of 16 per grade.
- A cap of one returned 25 Ponyta records spanning September 2024–September 2026, demonstrating why a per-grade limit is not a recent-date window or complete volume.
- The known Ponyta sale detail retained 27.46 as an explicit USD amount and shipping 17.59 with unknown currency; fees were null.
- Both sample assets returned an empty Alt active-listings array. This says nothing about their eBay supply. Populated-listing contract tests are synthetic; no populated live Alt supply sample was verified.
- Contract tests use four sanitized real history records plus one detail. They cover special CGC encodings, skip/correction flags, missing fields, partial GraphQL errors, malformed responses, local window filtering, bounded lazy details, failed-detail recovery, cancellation and supply separation. The underlying transport's byte/deadline limits still apply.
