# Free browser API evaluation — September 5, 2026

For the user's preferred free route, use Alt as a candidate source of card identity and cross-grade sales, with eBay Seller Hub Product Research for source comparison, broader searches, and shipping evidence. Both browser-facing services were observed working in the existing sessions. No paid data subscription or new account was required. This was endpoint discovery and a small data check, not implementation of an unattended collector.

**Alt: verified calls, not guessed endpoints.** Its current app sends GraphQL POST requests to:

```text
https://alt-platform-server.production.internal.onlyalt.com/graphql/<OperationName>
```

| Operation | Evidence and use |
|---|---|
| `Cert` | Verified in the user's certificate search: cert `110185364` resolves to the Hitmonlee Reverse Holo asset and reports PSA 1. Returns card identity, grader, grade, qualifiers and subgrades where available. |
| `SoldListing` | Verified response for one eBay sale. Returns transaction date, auction type, original listing title, display price, USD amount, shipping, fees, currency, asset identity, grader, grade, certificate when present, source URL and images. Several fields were null in the example. |
| `AssetMarketTransactions` | Verified 214 returned records for 1999 Base Set first-edition Ponyta, spanning 25 grader/grade encodings and dates from June 2021 to September 2026. The browser requested at most 16 per grader/grade group; this is a capped sample, not the complete sales population. |
| `AssetMarketTransactionsWithTimeSeriesData` | Observed authenticated browser request for a particular grade. It selects both market transactions and Alt's estimated-value time series/confidence fields. Keep the two forms of evidence distinct. |
| `AssetCardPops` | Observed browser request and displayed population data. Population is supporting context, not active supply. |
| `AssetDetails` | Observed browser request including canonical card identity, population, Alt value and active Alt listings. |
| `AssetLiveExternalTransactions` | Definition found in the currently served client bundle; not response-tested in this evaluation. Intended fields include external venue, grade, live bid information and buy-now price. |
| `SearchServiceConfig` | Definition found in the current client bundle. Supplies search configuration for assets, sold listings and other search indexes. Not separately replayed. |

The verified all-grades request used this variable shape:

```json
{
  "id": "cd3ecabf-7d43-4375-9428-1a7cdfe66426",
  "marketTransactionFilter": {
    "allGrades": true,
    "showSkipped": true,
    "maxTransactionsPerGrade": 16
  }
}
```

The ID is Alt's card/variant asset ID, not an eBay listing ID or slab certificate. The captured GraphQL request includes an authorization header; no token values were saved. An unauthenticated minimal query with an empty filter returned an empty array, so that probe does not establish anonymous access to the same history.

**Certificate lookup follow-up.** The user opened [Hitmonlee research](https://alt.xyz/itm/20c46c8c-4290-4953-b76f-5892bb442f87/research) by searching certificate `110185364`. The observed call was `POST /graphql/Cert`, with `operationName: "Cert"` and `variables: {"certNumber":"110185364"}`. Its response mapped to asset `20c46c8c-4290-4953-b76f-5892bb442f87`, named 2002 Pokemon Legendary Collection Reverse Holo Hitmonlee #13, with `gradingCompany: "PSA"` and `gradeNumber: "1.0"`. The research page and subsequent pricing queries were set to PSA 10. That is a separate research selection; it must not overwrite the owned slab's certificate grade. The page does not prove this individual certificate sold at any of the displayed comparable-sale prices.

The same asset's all-grades request returned 194 records, using the browser's limit of 16 per grade group. [alt-cert-evidence.json](alt-cert-evidence.json) saves the certificate response, request shapes and cross-grade records. This provides a concrete import path: certificate plus known grader → resolved asset and reported slab grade → sales for that asset across grades → identity/label validation → valuation. Only this one certificate was checked; fallback matching is still necessary for unrecognized certs and other grading companies.

The all-grades response includes `date`, `price`, `auctionHouse`, `auctionType`, `attributes.gradeNumber`, `attributes.gradingCompany`, `attributes.url`, `subjectToChange`, `consolidatedSkippedReason`, and `label`. Nine of the 214 records had a skip reason. Preserve those flags and review exclusion reasons before training. Grade encodings included CGC `0.0` and `10.5`; do not interpret these as an ordinary numeric quality ladder without checking how Alt maps them to actual labels. In this sample `label` was empty even on those encodings.

**Alt sold-search is a separate Typesense request.** The browser's Ponyta search used:

```text
POST https://slhgwnurt6v1e84fp.a1.typesense.net/multi_search
```

```json
{
  "searches": [{
    "q": "Ponyta",
    "preset": "timestamp_desc",
    "filter_by": "showResult:true",
    "per_page": 50,
    "page": 1
  }]
}
```

The response reported 1,009 matches and returned 50 records. These covered multiple Ponyta variants, not one card. Each document included asset ID, raw and normalized title, grader, grade, card number, year, variety, venue, sale format, sold date, price, eBay item ID and URL. Search authentication/configuration must come from the normal app session; the hostname and presets may change. The signed-out page received search results but opened a login dialog. The user's usual Chrome profile was already signed into Alt, and authenticated detail/history requests worked there.

**A small comparison against eBay succeeded.** Eleven eBay item IDs overlapped between the Alt all-grades sample and the previously captured Ponyta PSA 9 research results. All eleven item prices agreed to the cent: five auctions, four buy-now sales, and two Best Offer sales. The matched Best Offer examples were eBay IDs `397578980482` ($129.89) and `127943558744` ($160.00). This supports further testing; it does not validate all Alt prices, shipping, labels or catalog coverage. The new PSA 4 example had a $27.46 price and $17.59 shipping, with currency null and USD amount populated, illustrating why monetary fields need explicit normalization.

**eBay Product Research: verified internal endpoint.** The existing signed-in Seller Hub page sent:

```text
GET https://www.ebay.com/sh/research/api/search
```

Observed parameters include `marketplace`, `keywords`, `dayRange`, `startDate`, `endDate`, `categoryId`, `offset`, `limit`, `tabName`, `tz`, and repeated `modules` keys. The captured request used `tabName=SOLD` and modules `aggregates`, `searchResults`, and `resultsHeader`; a separate request used `metricsTrends`. Start and end dates were Unix milliseconds.

The response contained 21 rows for `Ponyta 60 1st PSA 9`, consistent with the earlier UI extraction. It was a stream of JSON modules separated by blank lines, not one JSON document. Modules included `ResultsHeaderModule`, `ResearchAggregateModule`, and `SearchResultsModule`. The result rows include title, an extended title containing additional item specifics, item ID, source link, sale format, average sale price, average shipping, quantity and last-sold date. Avoid treating a listing average with multiple sales as multiple independent transaction prices. Check the returned Sold/Active tab state: the UI can fall back to active results for an empty sold query.

This uses the Seller Hub website session, not developer OAuth credentials. A repeatable collector must handle session expiration, paging, module errors, changing response shapes, and deduplication. The evaluation captured existing browser responses; it did not export cookies or establish that a standalone HTTP client can replay the authenticated calls unchanged.

**Other candidates:** 130point remains a secondary lead. Its public sales URL returned HTTP 403 in direct checks, so no internal endpoint or working response was verified. There is no reason to add another dependency before testing Alt and eBay against the remaining sample.

Captured market-only payloads and responses are in [browser-api-evidence.json](browser-api-evidence.json). Public client assets used for discovery are retained under ignored `.artifacts/ebay-slab-evaluation`. No passwords, bearer tokens or cookie values are included in the report or evidence file.
