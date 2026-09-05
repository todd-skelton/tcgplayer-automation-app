// Opt-in: npx tsx app/features/ebay-slab-pricing/connections/providerConnections.integration.test.ts
// Creates an isolated schema in the local development database; no real credentials or HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import {
  clearProviderConnection,
  getProviderConnections,
  providerRequestGate,
  saveProviderConnection,
} from "./providerConnections.server";
import { ProviderRequestError } from "./providerRequest.server";

if (process.argv.includes("--claim")) {
  try {
    await providerRequestGate.claim("alt");
    console.log("claimed");
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    console.log(error.status);
  } finally {
    await getPool().end();
  }
} else {
  dotenv.config({
    path: [".env.development.local", ".env.local", ".env.development", ".env"],
    quiet: true,
  });
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
  );
  assert.ok(
    ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5433",
    "Use the local development database",
  );
  const admin = new pg.Client({ connectionString: url.toString() });
  const schema = `slab_connections_test_${randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const db = getPool();
  try {
    await db.query(
      await readFile(
        "db/migrations/024_add_slab_provider_connections.sql",
        "utf8",
      ),
    );
    await saveProviderConnection("alt", "fixture", "");
    const claimInProcess = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", fileURLToPath(import.meta.url), "--claim"],
          { env: process.env, windowsHide: true },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(output.trim().split(/\r?\n/).at(-1)!)
            : reject(new Error(output)),
        );
      });
    const results = await Promise.all(
      Array.from({ length: 4 }, claimInProcess),
    );
    assert.equal(results.filter((result) => result === "claimed").length, 1);
    assert.equal(results.filter((result) => result === "busy").length, 3);
    await db.query(
      "UPDATE slab_provider_connections SET lease_until = clock_timestamp() - interval '1 second'",
    );
    const oldLease = await providerRequestGate.claim("alt");
    await saveProviderConnection("alt", "replacement", "");
    await assert.rejects(providerRequestGate.claim("alt"), { status: "busy" });
    await providerRequestGate.release("alt", oldLease, {
      status: "reconnect-required",
      retryAt: Date.now() + 60000,
    });
    assert.equal((await getProviderConnections())[0].status, "unchecked");
    await assert.rejects(providerRequestGate.claim("alt"), { status: "busy" });
    await db.query(
      "UPDATE slab_provider_connections SET next_request_at = '-infinity'",
    );
    const lease = await providerRequestGate.claim("alt");
    assert.equal(lease.credential, "replacement");
    await providerRequestGate.release("alt", oldLease, {
      status: "unavailable",
      retryAt: Date.now(),
    });
    await assert.rejects(providerRequestGate.claim("alt"), { status: "busy" });
    await clearProviderConnection("alt");
    await providerRequestGate.release("alt", lease, {
      status: "connected",
      retryAt: Date.now(),
    });
    assert.equal((await getProviderConnections())[0].status, "not-configured");
    await assert.rejects(providerRequestGate.claim("alt"), {
      status: "not-configured",
    });
    await saveProviderConnection("alt", "replacement", "");
    const authLease = await providerRequestGate.claim("alt");
    await providerRequestGate.release("alt", authLease, {
      status: "reconnect-required",
      retryAt: Date.now(),
    });
    await assert.rejects(providerRequestGate.claim("alt"), {
      status: "reconnect-required",
    });
    await saveProviderConnection("alt", "reconnected", "");
    const reconnected = await providerRequestGate.claim("alt");
    assert.equal(reconnected.credential, "reconnected");
    const publicState = JSON.stringify(await getProviderConnections());
    assert.ok(
      !publicState.includes("reconnected") &&
        !publicState.includes("userAgent"),
    );
    console.log(
      "PASS four-process exclusion, cooldown, expiry recovery, lease fencing, masked status and reconnect without restart",
    );
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
