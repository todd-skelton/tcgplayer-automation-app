import assert from "node:assert/strict";
import salesFixture from "./fixtures/alt-sales.json";
import detailFixture from "./fixtures/alt-sale-detail.json";
import {
  createAltEvidenceProvider,
  parseAltSales,
  parseAltSaleDetail,
  parseAltSupply,
} from "./altEvidenceProvider.server";
import { createProviderRequest } from "../connections/providerRequest.server";

const assetId = salesFixture.data.asset.id;
const window = { from: "2020-01-01", to: "2026-09-05" };
const capturedAt = "2026-09-05T22:00:00Z";
const parsed = parseAltSales(
  JSON.stringify(salesFixture),
  assetId,
  window,
  16,
  capturedAt,
);
assert.equal(parsed.coverage.complete, false);
assert.equal(parsed.coverage.limitPerGrade, 16);
assert.equal(parsed.coverage.reason, "capped-per-grade");
assert.ok(parsed.sales.some((row) => row.skippedReason));
assert.ok(
  parsed.sales.some(
    (row) => row.grading.encoding === "10.5" && row.grading.number === null,
  ),
);
assert.ok(
  parsed.sales.every(
    (row) => row.price?.currency === null && row.shipping === null,
  ),
);
assert.ok(parsed.sales.some((row) => row.sourceItemId));
const narrow = parseAltSales(
  JSON.stringify(salesFixture),
  assetId,
  { from: "2026-09-04", to: "2026-09-05" },
  16,
  capturedAt,
);
assert.ok(
  narrow.sales.every((row) => row.date === null || row.date >= "2026-09-04"),
);
assert.equal(narrow.coverage.sourceCount, parsed.coverage.sourceCount);
assert.deepEqual(
  narrow.coverage.observedWindow,
  parsed.coverage.observedWindow,
);
const detailId = detailFixture.data.externalTransaction.id;
const detail = parseAltSaleDetail(JSON.stringify(detailFixture), detailId)!;
assert.equal(detail.price?.amount, 27.46);
assert.equal(detail.price?.currency, null);
assert.deepEqual(detail.convertedPrice, { amount: 27.46, currency: "USD" });
assert.deepEqual(detail.shipping, { amount: 17.59, currency: null });
assert.equal(detail.fees, null);
assert.equal(detail.shippingIncluded, null);
assert.equal(detail.buyerPremiumIncluded, null);
assert.equal(detail.card?.edition, "1st Edition");
assert.equal(detail.sourceItemId, "335037487554");
assert.equal(
  parseAltSaleDetail('{"data":{"externalTransaction":null}}', detailId),
  null,
);
for (const fixture of [
  { data: { asset: { id: assetId, marketTransactions: null } } },
  { data: salesFixture.data, errors: [{ message: "partial response" }] },
  { data: { asset: { id: "wrong", marketTransactions: [] } } },
]) {
  assert.throws(
    () =>
      parseAltSales(JSON.stringify(fixture), assetId, window, 16, capturedAt),
    { status: "invalid-response" },
  );
}
assert.throws(
  () =>
    parseAltSales(
      '{"errors":[{"extensions":{"code":"UNAUTHENTICATED"}}]}',
      assetId,
      window,
      16,
      capturedAt,
    ),
  { status: "reconnect-required" },
);
const incomplete = structuredClone(salesFixture);
Object.assign(incomplete.data.asset.marketTransactions[0], {
  date: null,
  price: null,
  subjectToChange: true,
});
const incompleteRow = parseAltSales(
  JSON.stringify(incomplete),
  assetId,
  window,
  16,
  capturedAt,
).sales[0];
assert.equal(incompleteRow.date, null);
assert.equal(incompleteRow.price, null);
assert.equal(incompleteRow.subjectToChange, true);
const unsafeUrl = structuredClone(salesFixture);
unsafeUrl.data.asset.marketTransactions[0].attributes.url =
  "javascript:alert(1)";
assert.equal(
  parseAltSales(JSON.stringify(unsafeUrl), assetId, window, 16, capturedAt)
    .sales[0].sourceUrl,
  null,
);
assert.deepEqual(
  parseAltSupply(
    JSON.stringify({ data: { asset: { id: assetId, activeListings: [] } } }),
    assetId,
  ),
  [],
);
const supplied = parseAltSupply(
  JSON.stringify({
    data: {
      asset: {
        id: assetId,
        activeListings: [
          {
            id: "listing",
            state: "ACTIVE",
            type: "unknown-new-format",
            listPrice: "123.45",
            items: [
              {
                asset: { id: assetId },
                attributes: { gradingCompany: "PSA", gradeNumber: "9.0" },
              },
            ],
          },
        ],
      },
    },
  }),
  assetId,
)[0];
assert.equal(supplied.priceKind, "unknown");
assert.equal(supplied.price?.currency, null);
assert.equal(supplied.quantity, null);

let calls = 0;
const provider = createAltEvidenceProvider(
  createProviderRequest(
    {
      claim: async () => ({
        id: "fixture",
        revision: 1,
        credential: "fixture",
        userAgent: "",
      }),
      release: async () => {},
    },
    async (_url, init) => {
      calls++;
      const operation = JSON.parse(String(init?.body));
      if (operation.operationName === "SoldListing")
        return new Response(JSON.stringify(detailFixture));
      assert.equal(operation.variables.marketTransactionFilter.allGrades, true);
      assert.equal(
        operation.variables.marketTransactionFilter.showSkipped,
        true,
      );
      assert.equal(
        operation.variables.marketTransactionFilter.maxTransactionsPerGrade,
        16,
      );
      assert.ok(!("tsFilter" in operation.variables));
      return new Response(JSON.stringify(salesFixture));
    },
  ),
  { now: () => new Date(capturedAt) },
);
await provider.getSales(assetId, window);
assert.equal(calls, 1, "history does not fetch details eagerly");
const [first, second] = await Promise.all([
  provider.getSaleDetail(detailId),
  provider.getSaleDetail(detailId),
]);
assert.equal(first, second);
assert.equal(calls, 2, "concurrent detail requests share one read");
await provider.getSaleDetail(detailId);
assert.equal(calls, 2);
await provider.getSaleDetail(` ${detailId} `);
assert.equal(calls, 2, "normalized detail IDs share the same memoized read");
let attempts = 0;
const limited = createAltEvidenceProvider(
  createProviderRequest(
    {
      claim: async () => ({
        id: "fixture",
        revision: 1,
        credential: "fixture",
        userAgent: "",
      }),
      release: async () => {},
    },
    async () => {
      attempts++;
      return new Response('{"data":{"externalTransaction":null}}');
    },
  ),
);
for (let index = 0; index < 32; index++)
  await limited.getSaleDetail(`detail-${index}`);
assert.throws(() => limited.getSaleDetail("detail-33"), { status: "busy" });
assert.equal(attempts, 32);
await assert.rejects(
  provider.getSales(assetId, { from: "2026-02-30", to: "2026-09-05" }),
  { status: "invalid-response" },
);
{
  let failures = 0;
  const retrying = createAltEvidenceProvider(
    createProviderRequest(
      {
        claim: async () => ({
          id: "fixture",
          revision: 1,
          credential: "fixture",
          userAgent: "",
        }),
        release: async () => {},
      },
      async () => {
        failures++;
        return new Response(
          JSON.stringify(
            failures === 1
              ? { data: detailFixture.data, errors: [{ message: "partial" }] }
              : detailFixture,
          ),
        );
      },
    ),
  );
  await assert.rejects(retrying.getSaleDetail(detailId), {
    status: "invalid-response",
  });
  await retrying.getSaleDetail(detailId);
  assert.equal(failures, 2, "failed details are not cached");
  const cancelled = createAltEvidenceProvider(
    createProviderRequest({
      claim: async () => {
        throw Error("Must not fetch");
      },
      release: async () => {},
    }),
    { signal: AbortSignal.abort("private cancellation reason") },
  );
  assert.throws(() => cancelled.getSaleDetail(detailId), {
    status: "cancelled",
  });
}
console.log(
  "PASS capped Alt evidence, explicit monetary uncertainty, lazy bounded details, partial errors and supply separation",
);
