// Node's half of the JSON route parity tests (crate::api::tests::answers_as_node): asks each Node
// route the requests below on the dev database and writes what it answered, scrubbed of buyers'
// details, to tests/fixtures/node/api/<name>.json. The Rust test sends the same requests through
// the app's router and scrubs its answer the same way before comparing.
//
// Every post here is a read or is refused before it writes, except shipping-intake-history, which
// refreshes the intake history it reads, as the shipping screen does.
//
//   TZ=UTC WORKERS_RUN_IN_PROCESS=false npx vite-node scripts/parity/record-node-answers.ts [name ...]
//   cargo test --lib the_route_answers_as_node_answered -- --ignored
if (process.env.WORKERS_RUN_IN_PROCESS !== "false") {
  throw new Error("Set WORKERS_RUN_IN_PROCESS=false so no worker starts in this process.");
}
if (process.env.TZ !== "UTC") throw new Error("Set TZ=UTC, as the production containers run.");

export {};

const { mkdirSync, writeFileSync } = await import("node:fs");
const { query } = await import("~/core/db/database.server");
const { getShippingExportConfig } = await import("~/features/shipping-export/config/shippingExportConfig.server");
const { scrub, scrubText } = await import("./scrub");

type Ask = { path: string; post?: string; headers?: Record<string, string> };
type Route = {
  pattern: string;
  module: () => Promise<{ loader?: Handler; action?: Handler }>;
  asks: () => Promise<Ask[]>;
};
type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<unknown>;

const sellerKey = (await getShippingExportConfig()).defaultSellerKey.trim();
const sameSite = { origin: "http://localhost", "sec-fetch-site": "same-origin" };
const post = (path: string, body: unknown, headers: Record<string, string> = sameSite): Ask => ({
  path,
  post: typeof body === "string" ? body : JSON.stringify(body),
  headers,
});
const one = async <T>(sql: string, values: unknown[] = []) => (await query<T & object>(sql, values))[0];

// A small priced batch with its publication, a small intake batch with its publication, and a
// batch number no batch has, so the recordings stay small.
const priced = 3471;
const intake = 2725;
const missing = 999_999_999;

const routes: Record<string, Route> = {
  "inventory-batches": {
    pattern: "/api/inventory-batches",
    module: () => import("~/features/pending-inventory/routes/api.inventory-batches"),
    asks: async () => [
      { path: "/api/inventory-batches" },
      post("/api/inventory-batches", {}),
      post("/api/inventory-batches", "not json"),
      post("/api/inventory-batches", { requestId: " " }),
      post("/api/inventory-batches", { requestId: "x".repeat(201) }),
      post("/api/inventory-batches", { requestId: "parity-refused", purchaseCost: { amount: "nope" } }),
    ],
  },
  "inventory-batch": {
    pattern: "/api/inventory-batches/:batchNumber",
    module: () => import("~/features/pending-inventory/routes/api.inventory-batch"),
    asks: async () => [
      { path: `/api/inventory-batches/${priced}` },
      { path: `/api/inventory-batches/${intake}` },
      { path: `/api/inventory-batches/${missing}` },
      { path: "/api/inventory-batches/0" },
      { path: "/api/inventory-batches/1.5" },
      { path: "/api/inventory-batches/abc" },
    ],
  },
  "inventory-batch-items": {
    pattern: "/api/inventory-batches/:batchNumber/items",
    module: () => import("~/features/pending-inventory/routes/api.inventory-batch-items"),
    asks: async () => [
      { path: `/api/inventory-batches/${priced}/items` },
      { path: `/api/inventory-batches/${priced}/items?scope=errors` },
      { path: `/api/inventory-batches/${intake}/items` },
      { path: `/api/inventory-batches/${missing}/items` },
      { path: "/api/inventory-batches/abc/items" },
    ],
  },
  "inventory-batch-results": {
    pattern: "/api/inventory-batches/:batchNumber/results",
    module: () => import("~/features/pending-inventory/routes/api.inventory-batch-results"),
    asks: async () => [
      { path: `/api/inventory-batches/${priced}/results` },
      { path: `/api/inventory-batches/${priced}/results?scope=manual-review` },
      { path: `/api/inventory-batches/${missing}/results` },
      { path: "/api/inventory-batches/abc/results" },
      post(`/api/inventory-batches/${priced}/results`, { batchNumber: 1, mode: "full", pricedSkus: [] }),
      post(`/api/inventory-batches/${priced}/results`, { batchNumber: priced, mode: "some", pricedSkus: [] }),
      post("/api/inventory-batches/abc/results", { batchNumber: 1, mode: "full", pricedSkus: [] }),
    ],
  },
  "inventory-batch-publications": {
    pattern: "/api/inventory-batches/:batchNumber/publications",
    module: () => import("~/features/pending-inventory/routes/api.inventory-batch-publications"),
    asks: async () => [
      { path: `/api/inventory-batches/${priced}/publications` },
      { path: `/api/inventory-batches/${intake}/publications` },
      { path: `/api/inventory-batches/${missing}/publications` },
      { path: "/api/inventory-batches/abc/publications" },
      post(`/api/inventory-batches/${priced}/publications`, { selectedSkus: "all" }),
      post(`/api/inventory-batches/${priced}/publications`, { selectedSkus: [1, -2] }),
      post("/api/inventory-batches/abc/publications", {}),
    ],
  },
  "forecast-calibration": {
    pattern: "/api/forecast-calibration",
    module: () => import("~/features/forecast-calibration/routes/api.forecast-calibration"),
    asks: async () =>
      ["", "?days=28", "?days=56", "?days=0", "?days=abc", "?days=2.5", "?days=28&days=7"].map((q) => ({
        path: `/api/forecast-calibration${q}`,
      })),
  },
  "shipping-thresholds": {
    pattern: "/api/shipping-thresholds",
    module: () => import("~/features/shipping-thresholds/routes/api.shipping-thresholds"),
    asks: async () =>
      ["", "?days=28", "?days=90", "?days=0", "?days=abc", "?days=2.5"].map((q) => ({
        path: `/api/shipping-thresholds${q}`,
      })),
  },
  "inventory-economics": {
    pattern: "/api/inventory-economics",
    module: () => import("~/features/inventory-economics/routes/api.inventory-economics"),
    asks: async () => [
      { path: "/api/inventory-economics" },
      post("/api/inventory-economics", {}),
      post("/api/inventory-economics", { action: "unknown", requestId: "parity" }),
      post("/api/inventory-economics", { action: "find_purchase_allocation_targets", requestId: "parity", batchNumbers: [intake] }),
      post("/api/inventory-economics", { action: "find_purchase_allocation_targets", requestId: "parity", batchNumbers: "x" }),
      post("/api/inventory-economics", { action: "record_purchase_cost", requestId: "parity", allocationRule: "guess" }),
      post("/api/inventory-economics", { action: "change_estimated_cost_rate", batchNumber: 0 }),
    ],
  },
  "inventory-fifo": {
    pattern: "/api/inventory-fifo",
    module: () => import("~/features/inventory-fifo/routes/api.inventory-fifo"),
    asks: async () => {
      const line = await one<{ id: string; order_number: string }>(
        `SELECT l.id::text AS id, o.order_number FROM inventory_fifo_lines l JOIN seller_orders o ON o.id = l.order_id WHERE l.seller_key = $1 AND l.current_revision_id IS NOT NULL ORDER BY l.order_time DESC, l.id LIMIT 1`,
        [sellerKey],
      );
      return [
        post("/api/inventory-fifo", { action: "list_holds", limit: 5 }),
        post("/api/inventory-fifo", { action: "find_order", orderNumber: line?.order_number ?? "none" }),
        post("/api/inventory-fifo", { action: "find_order", orderNumber: "NOT-AN-ORDER" }),
        post("/api/inventory-fifo", { action: "find_order" }),
        post("/api/inventory-fifo", { action: "list_revisions", lineId: line?.id ?? "0", limit: 5 }),
        post("/api/inventory-fifo", { action: "list_revisions" }),
        post("/api/inventory-fifo", { action: "record_disposition", requestId: "parity" }),
        post("/api/inventory-fifo", { action: "unknown" }),
        post("/api/inventory-fifo", { action: "list_holds", sellerKey: "another-seller" }),
      ];
    },
  },
  "inventory-intake-runs": {
    pattern: "/api/inventory-intake-runs",
    module: () => import("~/features/inventory-management/routes/api.inventory-intake-runs"),
    asks: async () => [
      { path: "/api/inventory-intake-runs" },
      post("/api/inventory-intake-runs", {}),
      post("/api/inventory-intake-runs", "not json"),
      post("/api/inventory-intake-runs", { requestId: "parity", workflow: "sell" }),
    ],
  },
  "inventory-history-diagnostics": {
    pattern: "/api/inventory-history-diagnostics",
    module: () => import("~/features/inventory-history/routes/api.inventory-history-diagnostics"),
    asks: async () => [{ path: "/api/inventory-history-diagnostics" }],
  },
  "inventory-opening-balance": {
    pattern: "/api/inventory-opening-balance",
    module: () => import("~/features/inventory-opening-balance/routes/api.inventory-opening-balance"),
    asks: async () => {
      const run = await one<{ id: string; observation_id: string }>(
        "SELECT id::text AS id, observation_id::text AS observation_id FROM inventory_opening_balance_runs WHERE seller_key = $1 ORDER BY created_at DESC LIMIT 1",
        [sellerKey],
      );
      return [
        post("/api/inventory-opening-balance", { action: "list_differences", observationId: run?.observation_id ?? "0" }),
        post("/api/inventory-opening-balance", { action: "list_observation_items", observationId: run?.observation_id ?? "0" }),
        post("/api/inventory-opening-balance", { action: "list_preview_items", runId: run?.id ?? "0" }),
        post("/api/inventory-opening-balance", { action: "list_differences" }),
        post("/api/inventory-opening-balance", { action: "capture" }),
        post("/api/inventory-opening-balance", { action: "apply", requestId: "parity" }),
        post("/api/inventory-opening-balance", { action: "unknown" }),
        post("/api/inventory-opening-balance", { action: "list_differences", sellerKey: "another-seller" }),
      ];
    },
  },
  "seller-order-history": {
    pattern: "/api/seller-order-history",
    module: () => import("~/features/seller-order-history/routes/api.seller-order-history"),
    asks: async () => [
      { path: "/api/seller-order-history" },
      { path: "/api/seller-order-history?sellerKey=another-seller" },
      post("/api/seller-order-history", { action: "unknown" }),
      post("/api/seller-order-history", { action: "import_csv" }),
    ],
  },
  "shipping-intake-history": {
    pattern: "/api/shipping-export/intake-history",
    module: () => import("~/features/shipping-export/routes/api.shipping-export-intake-history"),
    asks: async () => {
      const orders = await query<{ order_number: string; order_time: Date; lines: Array<{ skuId: number; quantity: number; unitPrice: number }> }>(
        `SELECT o.order_number, o.order_time,
                json_agg(json_build_object('skuId', l.sku_id, 'quantity', l.ordered_quantity,
                  'unitPrice', round(l.gross_item_proceeds / l.ordered_quantity, 2)) ORDER BY l.sku_id) AS lines
           FROM seller_orders o JOIN seller_order_lines l ON l.order_id = o.id
          WHERE o.seller_key = $1 AND l.ordered_quantity > 0
          GROUP BY o.id ORDER BY o.order_time DESC LIMIT 5`,
        [sellerKey],
      );
      const asked = orders.map((order) => ({
        orderNumber: order.order_number,
        orderDate: order.order_time.toISOString(),
        itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
        valueOfProducts: order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
        products: order.lines.map((line) => ({ ...line, skuId: String(line.skuId) })),
      }));
      const path = "/api/shipping-export/intake-history";
      return [
        post(path, { sellerKey, orders: asked }),
        post(path, { orders: asked.slice(0, 1) }),
        post(path, { orders: [] }),
        post(path, { sellerKey: "another-seller", orders: [] }),
        post(path, { orders: "none" }),
        post(path, { orders: [{ orderNumber: " " }] }),
        post(path, { orders: [{ ...asked[0], products: [{ quantity: 0, unitPrice: 1 }] }] }),
      ];
    },
  },
  "slab-identities": {
    pattern: "/api/slab-identities",
    module: () => import("~/features/ebay-slab-pricing/routes/api.slab-identities"),
    asks: async () => [
      post("/api/slab-identities", "null"),
      post("/api/slab-identities", { intent: "unknown" }),
      post("/api/slab-identities", { intent: "lookup", grader: "PSA", certificateNumber: "", expected: 1 }),
      post("/api/slab-identities", { intent: "confirm", grader: "PSA" }),
    ],
  },
  "slab-evidence": {
    pattern: "/api/slab-evidence",
    module: () => import("~/features/ebay-slab-pricing/routes/api.slab-evidence"),
    asks: async () => [
      { path: "/api/slab-evidence?keys=" },
      { path: "/api/slab-evidence?keys=a,b" },
      { path: "/api/slab-evidence?revision=00000000-0000-0000-0000-000000000000" },
      post("/api/slab-evidence", { intent: "research" }),
      post("/api/slab-evidence", { intent: "unknown" }),
      post("/api/slab-evidence", "not json"),
    ],
  },
  "slab-recommendations": {
    pattern: "/api/slab-recommendations",
    module: () => import("~/features/ebay-slab-pricing/routes/api.slab-recommendations"),
    asks: async () => [
      { path: "/api/slab-recommendations" },
      { path: "/api/slab-recommendations?id=00000000-0000-0000-0000-000000000000" },
      post("/api/slab-recommendations", { intent: "unknown" }),
      post("/api/slab-recommendations", "not json"),
    ],
  },
  "slab-inventory": {
    pattern: "/api/slab-inventory",
    module: () => import("~/features/ebay-slab-pricing/routes/api.slab-inventory"),
    asks: async () => [
      { path: "/api/slab-inventory" },
      { path: "/api/slab-inventory?seller=parity-seller&limit=5" },
      { path: "/api/slab-inventory?seller=parity-seller&limit=abc" },
      post("/api/slab-inventory", { seller: "parity-seller", intent: "resolve-identity", id: "x" }),
      post("/api/slab-inventory", { seller: "parity-seller", intent: "unknown" }),
      post("/api/slab-inventory", "not json"),
    ],
  },
  "slab-comp-decisions": {
    pattern: "/api/slab-comp-decisions",
    module: () => import("~/features/ebay-slab-pricing/routes/api.slab-comp-decisions"),
    asks: async () => [
      { path: "/api/slab-comp-decisions" },
      { path: "/api/slab-comp-decisions?group=parity&revisions=a,b" },
      post("/api/slab-comp-decisions", {}),
      post("/api/slab-comp-decisions", "not json"),
    ],
  },
};


// The route's params for a path, from its pattern.
function params(pattern: string, path: string): Record<string, string> {
  const names = pattern.split("/");
  const values = path.split("?")[0].split("/");
  return Object.fromEntries(
    names.flatMap((name, i) => (name.startsWith(":") ? [[name.slice(1), decodeURIComponent(values[i])]] : [])),
  );
}

// What a loader or action gave, as the client read it: a Response, React Router's data(), or a
// plain value.
async function answer(given: unknown) {
  if (given instanceof Response) {
    return { status: given.status, cacheControl: given.headers.get("cache-control"), body: await given.json() };
  }
  const shaped = given as { type?: string; data?: unknown; init?: ResponseInit | null };
  if (shaped?.type === "DataWithResponseInit") {
    const headers = new Headers(shaped.init?.headers);
    return { status: shaped.init?.status ?? 200, cacheControl: headers.get("cache-control"), body: shaped.data };
  }
  return { status: 200, cacheControl: null, body: given };
}

const wanted = process.argv.slice(2);
const folder = "tests/fixtures/node/api";
mkdirSync(folder, { recursive: true });
for (const [name, route] of Object.entries(routes)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const handlers = await route.module();
  const recorded = [];
  for (const ask of await route.asks()) {
    const request = new Request(`http://localhost${ask.path}`, {
      method: ask.post === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...ask.headers },
      body: ask.post,
    });
    const handler = ask.post === undefined ? handlers.loader : handlers.action;
    if (!handler) throw new Error(`${name}: no ${ask.post === undefined ? "loader" : "action"}`);
    const given = await answer(await handler({ request, params: params(route.pattern, ask.path) }));
    // A body read back through JSON, as the client read it: dates as text, undefined dropped.
    const body = scrub(JSON.parse(JSON.stringify(given.body)));
    recorded.push({
      path: ask.path,
      ...(ask.post === undefined ? {} : { post: scrubText(ask.post) }),
      ...(ask.headers ? { headers: ask.headers } : {}),
      status: given.status,
      ...(given.cacheControl ? { cacheControl: given.cacheControl } : {}),
      body,
    });
  }
  writeFileSync(`${folder}/${name}.json`, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`${name}: ${recorded.length} answers`);
}
process.exit(0);
