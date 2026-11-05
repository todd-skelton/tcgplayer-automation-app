// Records Node's publication worker a turn at a time (inventoryPublicationWorker.server.ts's tick,
// past its Seller Portal writes check) against Seller Portal stood in, for
// `inventory_publication::worker`'s `turns_run_as_node_runs_them`. Each case seeds
// pubworker-seed.sql and its own setup on a fresh copy of the dev database; each post is answered
// with the case's next scripted answer (`$rows` the rows the post carried, `$uploaded` every SKU
// uploaded so far, published) and its form recorded. Nothing is posted to Seller Portal, and its
// writes stay disabled. Writes the case to tests/fixtures/node/publication/pubworker.node.json.
//
//   node scripts/parity/pubworker.mjs
import { readFileSync, writeFileSync } from "node:fs";

if (!process.env.DATABASE_URL?.endsWith("/pubworker_parity")) throw new Error("Run through scripts/parity/pubworker.mjs");
if (process.env.SELLER_PORTAL_WRITES_ENABLED) throw new Error("Seller Portal writes must stay disabled");
const OUT = "tests/fixtures/node/publication";
const index = Number(process.argv[2]);
const theCase = JSON.parse(readFileSync(`${OUT}/pubworker-cases.json`, "utf8"))[index];
const { getPool, queryOne } = await import("~/core/db/database.server");
const { inventoryPublicationsRepository, inventoryPublicationSettingsRepository } = await import("~/core/db");
const { sellerPortal } = await import("~/core/clients");
const { executeClaimedStagedPublication } = await import("~/features/inventory-publication/services/inventoryPublicationWorker.server");
const { planNextQueuedIntakePublication } = await import("~/features/inventory-publication/services/queuedIntakePublication.server");
const pool = getPool();
await pool.query(readFileSync(`${OUT}/pubworker-seed.sql`, "utf8") + "\n" + theCase.setup);

const answers = [...theCase.portal];
const uploaded: number[] = [];
const calls: { path: string; form: string }[] = [];
const resolve = (value: unknown, rows: number): unknown => {
  if (value === "$rows") return rows;
  if (value === "$uploaded") return uploaded.map((sku) => ({ ProductConditionId: sku, Message: null }));
  if (Array.isArray(value)) return value.map((v) => resolve(v, rows));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, rows)]));
  return value;
};
const post = async (path: string, form: URLSearchParams, observe?: (metadata: unknown) => void) => {
  calls.push({ path, form: form.toString().replace(/inventory-publication-\d+\.csv/g, "inventory-publication-ID.csv") });
  const skus = [...form.entries()].filter(([name]) => /^data\[\d+\]\[ProductConditionId\]$/.test(name)).map(([, sku]) => Number(sku));
  uploaded.push(...skus);
  const scripted = answers.shift() ?? { error: { message: "The stand-in has no answer.", code: null, response: null } };
  const metadata = (a: { status: number; contentType: string | null; redirected: boolean | null }) =>
    ({ status: a.status, contentType: a.contentType ?? null, redirected: a.redirected ?? null });
  if (scripted.ok) {
    observe?.(metadata(scripted.ok));
    return resolve(scripted.ok.data, skus.length);
  }
  const error = Object.assign(new Error(scripted.error.message), { code: scripted.error.code ?? undefined }) as Error & { response?: unknown };
  if (scripted.error.response) {
    error.response = { status: scripted.error.response.status, data: scripted.error.response.data };
    observe?.(metadata(scripted.error.response));
  }
  throw error;
};
// The worker's own dependencies run unchanged; only the client's post is stood in.
sellerPortal.post = ((path: string, form: URLSearchParams, options?: { observeResponse?: (metadata: unknown) => void }) =>
  post(path, form, options?.observeResponse)) as typeof sellerPortal.post;

const WORKER = "port-worker";
const LEASE_MS = 30_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function turn(): Promise<string> {
  let publication;
  try {
    await inventoryPublicationsRepository.recoverPublicationsWithSavedOutcomes();
    await inventoryPublicationsRepository.recoverExpiredClaims();
    const configuration = await inventoryPublicationSettingsRepository.get();
    if (configuration.settings.globalPaused || configuration.runtime.circuitOpen || configuration.runtime.authenticationStatus === "invalid") return "stopped";
    try {
      await planNextQueuedIntakePublication(configuration.settings.policy);
    } catch (error) {
      console.error("Queued intake publication planning failed; existing publications can continue:", error);
    }
    publication = await inventoryPublicationsRepository.claimNextPlanned(WORKER, LEASE_MS);
  } catch (error) {
    return `failed: ${message(error)}`;
  }
  if (!publication) return "nothing planned";
  const key = (await queryOne<{ key: string }>("SELECT planning_key AS key FROM inventory_publications WHERE id = $1", [publication.id]))!.key
    .replace(/^inventory-batch-pricing-job:(\d+):selection:.*$/, "inventory-batch-pricing-job:$1:selection");
  try {
    if (publication.method === "staged_delta") {
      await executeClaimedStagedPublication(publication, WORKER);
    } else {
      // processClaimedPublication's direct branch, as the worker runs it.
      await inventoryPublicationsRepository.markPlannedItems(publication.id, "failed", "unsupported_publication_method", "The direct absolute publication worker is not implemented.");
      await inventoryPublicationsRepository.transitionStatus(publication.id, "publishing", "failed", {
        workerId: WORKER, errorCode: "unsupported_publication_method", errorMessage: "The direct absolute publication worker is not implemented.",
      });
    }
    return `published ${key}`;
  } catch (error) {
    return `failed: ${message(error)}`;
  }
}

const turns: string[] = [];
for (let step = 0; step < theCase.steps; step++) turns.push(await turn());
const capture = readFileSync(`${OUT}/pubworker-capture.sql`, "utf8");
const captured = JSON.parse(Object.values((await pool.query(capture)).rows[0])[0] as string);
const out = `${OUT}/pubworker.node.json`;
let recorded: unknown[] = [];
try {
  recorded = JSON.parse(readFileSync(out, "utf8"));
} catch {
  recorded = [];
}
recorded[index] = { name: theCase.name, turns, calls, left: answers.length, captured };
writeFileSync(out, JSON.stringify(recorded, null, 1) + "\n");
console.log(`${theCase.name}: ${JSON.stringify(turns)}, ${calls.length} posts, ${answers.length} answers left`);
await pool.end();
