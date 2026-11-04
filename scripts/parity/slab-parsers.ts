// Records what Node's slab evidence parsers read from the committed provider fixtures, and from edge
// cases built from them, for the Rust parsers to be checked against
// (`slab_evidence::alt` and `slab_evidence::ebay`'s `answers_are_read_as_node_reads_them`).
//
//   npx vite-node scripts/parity/slab-parsers.ts
//
// Writes tests/fixtures/node/slab/alt-parse.json and ebay-parse.json. Reads no database and no
// provider: every answer is one of the fixtures, handed to Node's code in place of the network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  parseAltSaleDetail,
  parseAltSales,
  parseAltSupply,
} from "../../app/features/ebay-slab-pricing/evidence/altEvidenceProvider.server";
import { createEbayResearchProvider } from "../../app/features/ebay-slab-pricing/evidence/ebayResearchProvider.server";
import { createProviderRequest } from "../../app/features/ebay-slab-pricing/connections/providerRequest.server";

const FIXTURES = "app/features/ebay-slab-pricing/evidence/fixtures";
const OUT = "tests/fixtures/node/slab";
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}`, "utf8"));
const clone = <T>(value: T): T => structuredClone(value);
const answer = (read: () => unknown) => {
  try {
    return { out: read() ?? null };
  } catch (error) {
    return { error: (error as { status?: string }).status ?? String(error) };
  }
};
const asOf = "2026-09-05T22:00:00.000Z";

// Alt
const sales = fixture("alt-sales.json");
const detail = fixture("alt-sale-detail.json");
const assetId: string = sales.data.asset.id;
const detailId: string = detail.data.externalTransaction.id;
const wide = { from: "2020-01-01", to: "2026-09-05" };
const narrow = { from: "2026-09-04", to: "2026-09-05" };
const incomplete = clone(sales);
Object.assign(incomplete.data.asset.marketTransactions[0], { date: null, price: null, subjectToChange: true });
const unsafe = clone(sales);
unsafe.data.asset.marketTransactions[0].attributes.url = "javascript:alert(1)";
const listing = {
  id: "listing",
  state: "ACTIVE",
  type: "unknown-new-format",
  listPrice: "123.45",
  createdAt: "2026-09-01T00:00:00Z",
  expiresAt: null,
  items: [{ asset: { id: assetId }, attributes: { gradingCompany: "PSA", gradeNumber: "9.0" } }, { asset: null }],
};
const altCases: { name: string; kind: "sales" | "detail" | "supply"; body: unknown; args?: unknown[] }[] = [
  { name: "sales", kind: "sales", body: sales, args: [wide, 16] },
  { name: "sales in a narrow window", kind: "sales", body: sales, args: [narrow, 16] },
  { name: "sales with no transactions", kind: "sales", body: { data: { asset: { id: assetId, marketTransactions: [] } } }, args: [wide, 4] },
  { name: "sales null", kind: "sales", body: { data: { asset: { id: assetId, marketTransactions: null } } }, args: [wide, 16] },
  { name: "sales with errors", kind: "sales", body: { data: sales.data, errors: [{ message: "partial response" }] }, args: [wide, 16] },
  { name: "sales of another asset", kind: "sales", body: { data: { asset: { id: "wrong", marketTransactions: [] } } }, args: [wide, 16] },
  { name: "sales unauthenticated", kind: "sales", body: { errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }, args: [wide, 16] },
  { name: "sales not JSON", kind: "sales", body: "<html>", args: [wide, 16] },
  { name: "sales with an incomplete row", kind: "sales", body: incomplete, args: [wide, 16] },
  { name: "sales with an unsafe URL", kind: "sales", body: unsafe, args: [wide, 16] },
  { name: "detail", kind: "detail", body: detail },
  { name: "detail not found", kind: "detail", body: { data: { externalTransaction: null } } },
  { name: "detail of another sale", kind: "detail", body: { data: { externalTransaction: { ...detail.data.externalTransaction, id: "other" } } } },
  { name: "supply empty", kind: "supply", body: { data: { asset: { id: assetId, activeListings: [] } } } },
  { name: "supply", kind: "supply", body: { data: { asset: { id: assetId, activeListings: [listing] } } } },
  { name: "supply of another asset", kind: "supply", body: { data: { asset: { id: "wrong", activeListings: [] } } } },
];
const altResults = altCases.map((c) => {
  const body = typeof c.body === "string" ? c.body : JSON.stringify(c.body);
  const read = () => {
    if (c.kind === "sales") {
      const [window, limit] = c.args as [typeof wide, number];
      return parseAltSales(body, assetId, window, limit, asOf);
    }
    return c.kind === "detail" ? parseAltSaleDetail(body, detailId) : parseAltSupply(body, assetId);
  };
  return { name: c.name, kind: c.kind, body, ...(c.args ? { args: c.args } : {}), ...answer(read) };
});

// eBay Research
const encode = (modules: unknown[]) => modules.map((m) => JSON.stringify(m)).join("\r\n\r\n");
const sold = fixture("ebay-sold.json");
const active = fixture("ebay-active.json");
const empty = fixture("ebay-empty.json");
const emptyActive = fixture("ebay-empty-active.json");
const query = { keywords: "Ponyta 60 1st PSA 9", window: { from: "2026-06-07", to: "2026-09-05" } };
const nowhere = { ...query, keywords: "Ponyta nonexistent-cert-0000000000" };
const several = clone(sold);
several.at(-1).results[0].itemssold.textSpans[0].text = "3";
// The header shows a range starting a day later than the one asked for.
const shifted = JSON.parse(JSON.stringify(sold).replace("Jun 7, 2026", "Jun 8, 2026"));
const ebayCases: { name: string; query: Record<string, unknown>; tab: "sales" | "supply"; modules: unknown[] | string }[] = [
  { name: "sold", query, tab: "sales", modules: sold },
  { name: "sold, a second page", query: { ...query, offset: 50 }, tab: "sales", modules: sold },
  { name: "sold, ten a page in Denver", query: { ...query, limit: 10, timezone: "America/Denver" }, tab: "sales", modules: sold },
  { name: "sold, several sold in a row", query, tab: "sales", modules: several },
  { name: "sold, a different date range shown", query, tab: "sales", modules: shifted },
  { name: "active answered for sales", query, tab: "sales", modules: active },
  { name: "active", query, tab: "supply", modules: active },
  { name: "sold answered for supply", query, tab: "supply", modules: sold },
  { name: "nothing found", query: nowhere, tab: "sales", modules: empty },
  { name: "nothing active", query: nowhere, tab: "supply", modules: emptyActive },
  { name: "nothing found for other keywords", query, tab: "sales", modules: empty },
  { name: "a frame missing", query, tab: "sales", modules: sold.slice(0, -1) },
  { name: "a sign-in page", query, tab: "sales", modules: "<html>Sign in</html>" },
  { name: "no keywords", query: { ...query, keywords: "  " }, tab: "sales", modules: sold },
  { name: "a window backwards", query: { ...query, window: { from: "2026-09-05", to: "2026-06-07" } }, tab: "sales", modules: sold },
  { name: "thirty a page", query: { ...query, limit: 30 }, tab: "sales", modules: sold },
  { name: "an offset off the page", query: { ...query, offset: 25 }, tab: "sales", modules: sold },
  { name: "an unknown time zone", query: { ...query, timezone: "Mars/Olympus" }, tab: "sales", modules: sold },
];
const ebayResults = [];
for (const c of ebayCases) {
  const wire = typeof c.modules === "string" ? c.modules : encode(c.modules);
  let path: string | null = null;
  const gate = {
    claim: async () => ({ id: "fixture", revision: 1, credential: "fixture", userAgent: "fixture" }),
    release: async () => {},
  };
  const client = createEbayResearchProvider(
    createProviderRequest(gate, async (url: string | URL) => {
      const asked = new URL(String(url));
      path = asked.pathname + asked.search;
      return new Response(wire);
    }),
    { now: () => new Date(asOf) },
  );
  let result: { out?: unknown; error?: string };
  try {
    result = { out: c.tab === "sales" ? await client.getSalesPage(c.query as never) : await client.getSupplyPage(c.query as never) };
  } catch (error) {
    result = { error: (error as { status?: string }).status ?? String(error) };
  }
  ebayResults.push({ name: c.name, query: c.query, tab: c.tab, wire, path, ...result });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/alt-parse.json`, JSON.stringify({ assetId, detailId, asOf, results: altResults }, null, 1) + "\n");
writeFileSync(`${OUT}/ebay-parse.json`, JSON.stringify({ asOf, results: ebayResults }, null, 1) + "\n");
console.log(`alt ${altResults.length} cases, ebay ${ebayResults.length} cases`);
for (const r of [...altResults, ...ebayResults]) console.log(`  ${r.name}: ${"error" in r ? r.error : "read"}`);
