import assert from "node:assert/strict";
import soldFixture from "./fixtures/ebay-sold.json";
import activeFixture from "./fixtures/ebay-active.json";
import emptyFixture from "./fixtures/ebay-empty.json";
import emptyActiveFixture from "./fixtures/ebay-empty-active.json";
import identityFixture from "../identity/fixtures/alt-cert-110185364.json";
import { createResearchStream } from "./ebayResearchStream.server";
import {
  buildResearchKeywords,
  createEbayResearchProvider,
  researchMidnight,
} from "./ebayResearchProvider.server";
import { createProviderRequest } from "../connections/providerRequest.server";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";

const query = {
  keywords: "Ponyta 60 1st PSA 9",
  window: { from: "2026-06-07", to: "2026-09-05" },
};
const encode = (modules: unknown[]) =>
  modules.map((module) => JSON.stringify(module)).join("\r\n\r\n");
const wire = encode(soldFixture);
for (const size of [1, 2, 7, 97, wire.length]) {
  const stream = createResearchStream(query.keywords);
  for (let offset = 0; offset < wire.length; offset += size)
    stream.push(wire.slice(offset, offset + size));
  const result = stream.finish();
  assert.equal(result.state, "sold");
  assert.equal((result.results.results as unknown[]).length, 3);
}
const streamFailure = (modules: unknown[], status: string) => {
  assert.throws(
    () => {
      const stream = createResearchStream(query.keywords);
      stream.push(encode(modules));
      stream.finish();
    },
    { status },
  );
};
streamFailure(soldFixture.slice(0, -1), "invalid-response");
streamFailure([...soldFixture, soldFixture[1]], "invalid-response");
streamFailure(
  [
    {
      _type: "PageErrorModule",
      severity: "ERROR",
      messages: [{ textSpans: [{ text: "Backend failed" }] }],
    },
    ...soldFixture.slice(1),
  ],
  "unavailable",
);
streamFailure(
  [
    {
      _type: "PageErrorModule",
      severity: "WARNING",
      messages: [{ textSpans: [{ text: "Partial data unavailable" }] }],
    },
    ...soldFixture.slice(1),
  ],
  "unavailable",
);
assert.throws(() => createResearchStream().push("<html>Sign in</html>"), {
  status: "reconnect-required",
});
assert.throws(
  () => createResearchStream().push("x".repeat(2 * 1024 * 1024 + 1)),
  { status: "invalid-response" },
);
assert.throws(
  () => {
    const stream = createResearchStream();
    stream.push(wire.slice(0, -4));
    stream.finish();
  },
  { status: "invalid-response" },
);
streamFailure(
  Array.from({ length: 17 }, () => ({ _type: "UnusedModule" })),
  "invalid-response",
);

function provider(modules: unknown[], maxRequests = 3) {
  let calls = 0;
  const requests: URL[] = [];
  const gate = {
    claim: async () => ({
      id: "fixture",
      revision: 1,
      credential: "fixture",
      userAgent: "fixture",
    }),
    release: async () => {},
  };
  const client = createEbayResearchProvider(
    createProviderRequest(gate, async (url) => {
      calls++;
      requests.push(new URL(String(url)));
      const bytes = new TextEncoder().encode(encode(modules));
      // Byte chunks split both JSON frames and multi-byte characters in extended titles.
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7)
              controller.enqueue(bytes.slice(offset, offset + 7));
            controller.close();
          },
        }),
      );
    }),
    { maxRequests },
  );
  return { client, calls: () => calls, requests };
}
const sold = provider(soldFixture);
const result = await sold.client.getSalesPage(query);
assert.equal(result.status, "sold");
assert.ok(result.status === "sold");
assert.equal(result.sales.length, 3);
assert.equal(result.sales[0].kind, "listing-average");
assert.equal(result.sales[0].quantity, 1);
assert.equal(
  result.sales[0].assetId,
  null,
  "query identity is not assigned to search candidates",
);
assert.equal(result.sales[0].grading.grader, "UNKNOWN");
assert.deepEqual(result.sales[0].price, { amount: 124.99, currency: "USD" });
assert.deepEqual(result.sales[0].shipping, { amount: 0, currency: "USD" });
assert.equal(result.sales[0].date, "2026-06-21");
assert.ok(result.sales[0].extendedTitle?.includes("Pokémon"));
assert.equal(result.sales[0].shippingIncluded, false);
assert.equal(result.coverage.complete, false);
assert.equal(result.page.nextOffset, null);
assert.deepEqual(sold.requests[0].searchParams.getAll("modules"), [
  "aggregates",
  "searchResults",
  "resultsHeader",
]);
assert.equal(sold.requests[0].searchParams.get("marketplace"), "EBAY-US");
assert.equal(sold.calls(), 1);
const fallback = await provider(activeFixture).client.getSalesPage(query);
assert.equal(fallback.status, "active-fallback");
assert.ok(
  !("sales" in fallback),
  "active fallback cannot return sale observations",
);
const active = await provider(activeFixture).client.getSupplyPage(query);
assert.equal(active.listings[0].priceKind, "bid");
assert.deepEqual(active.listings[0].price, { amount: 9.5, currency: "USD" });
assert.equal(active.listings[0].quantity, null);
assert.equal(active.listings[1].priceKind, "ask");
assert.equal(
  active.listings[2].priceKind,
  "ask",
  "Best Offer availability is still an asking price in active results",
);
const empty = await provider(emptyFixture).client.getSalesPage({
  ...query,
  keywords: "Ponyta nonexistent-cert-0000000000",
});
assert.equal(empty.status, "sold");
assert.ok(empty.status === "sold");
assert.deepEqual(empty.sales, []);
assert.equal(empty.page.nextOffset, null);
const emptyActive = await provider(emptyActiveFixture).client.getSupplyPage({
  ...query,
  keywords: "Ponyta nonexistent-cert-0000000000",
});
assert.deepEqual(emptyActive.listings, []);
await assert.rejects(
  provider(emptyFixture).client.getSalesPage(query),
  { status: "unavailable" },
  "an unrelated empty-search message is not accepted",
);

const multi = structuredClone(soldFixture) as any[];
multi.at(-1).results[0].itemssold.textSpans[0].text = "3";
const aggregated = await provider(multi).client.getSalesPage(query);
assert.ok(aggregated.status === "sold");
assert.equal(aggregated.sales[0].quantity, 3);
assert.equal(aggregated.sales[0].kind, "listing-average");
assert.equal(
  aggregated.sales.length,
  3,
  "an average is never expanded into individual sales",
);
const mismatch = structuredClone(soldFixture) as any[];
mismatch.at(-1).pagination.currentPageNum = 2;
await assert.rejects(provider(mismatch).client.getSalesPage(query), {
  status: "invalid-response",
});
const missingRows = structuredClone(soldFixture) as any[];
missingRows.at(-1).results.pop();
await assert.rejects(provider(missingRows).client.getSalesPage(query), {
  status: "invalid-response",
});
const wrongWindow = structuredClone(soldFixture) as any[];
wrongWindow[1].dateRange.textSpans[0].text = "Jun 8, 2026";
await assert.rejects(provider(wrongWindow).client.getSalesPage(query), {
  status: "invalid-response",
});
const limited = provider(soldFixture, 1);
await limited.client.getSalesPage(query);
await assert.rejects(limited.client.getSalesPage(query), { status: "busy" });
assert.equal(limited.calls(), 1);
await assert.rejects(
  provider(soldFixture).client.getSalesPage({ ...query, offset: 1 }),
  { status: "invalid-response" },
);
const partial = structuredClone(soldFixture) as any[];
partial.at(-1).pagination.next.disabled = false;
const partialPage = await provider(partial).client.getSalesPage(query);
assert.ok(partialPage.status === "sold");
assert.equal(partialPage.page.partial, true);
assert.equal(partialPage.page.nextOffset, 50);
assert.equal(
  researchMidnight("2026-03-09", "America/Chicago") -
    researchMidnight("2026-03-08", "America/Chicago"),
  23 * 3600000,
);
assert.equal(
  researchMidnight("2026-11-02", "America/Chicago") -
    researchMidnight("2026-11-01", "America/Chicago"),
  25 * 3600000,
);
const identity = parseAltCertificate(JSON.stringify(identityFixture))!.identity;
identity.card.language = "English";
identity.card.stamp = "Promo";
const keywords = buildResearchKeywords(identity, "omit-set");
assert.ok(
  keywords.includes("English") &&
    keywords.includes("Promo") &&
    keywords.includes("PSA 1"),
);
assert.ok(!keywords.includes("Legendary Collection"));
console.log(
  "PASS eBay streaming, explicit sold state, empty/error distinction, aggregates, bid/ask separation, paging bounds and timezone windows",
);
