import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createProviderRequest,
  ProviderRequestError,
  retryAfterMs,
  type ProviderRequestGate,
} from "./providerRequest.server";
import {
  validateAltConnection,
  validateEbayConnection,
} from "./checkProviderConnection.server";
import { validateCredential } from "./providerConnections.server";
import { createProviderConnectionsAction } from "./providerConnectionsAction.server";

const lease = {
  id: "lease",
  revision: 1,
  credential: "private=value",
  userAgent: "test-agent",
};
const path = "/sh/research/api/search";
const fails = (status: string) => (error: unknown) =>
  error instanceof ProviderRequestError && error.status === status;
function harness(
  fetcher: typeof fetch,
  overrides: Partial<ProviderRequestGate> = {},
) {
  const releases: Array<Parameters<ProviderRequestGate["release"]>[2]> = [];
  let claims = 0;
  return {
    releases,
    claims: () => claims,
    request: createProviderRequest(
      {
        claim: async () => {
          claims++;
          return lease;
        },
        release: async (_provider, _lease, result) => {
          releases.push(result);
        },
        ...overrides,
      },
      fetcher,
    ),
  };
}

for (const provider of ["alt", "ebayResearch"] as const) {
  const h = harness(async (url, init) => {
    assert.equal(
      new URL(String(url)).hostname,
      provider === "alt"
        ? "alt-platform-server.production.internal.onlyalt.com"
        : "www.ebay.com",
    );
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("authorization"),
      provider === "alt" ? `Bearer ${lease.credential}` : null,
    );
    assert.equal(
      headers.get("cookie"),
      provider === "ebayResearch" ? lease.credential : null,
    );
    assert.equal(init?.redirect, "manual");
    return new Response("{}");
  });
  await h.request(provider, {
    path: provider === "alt" ? "/graphql/Me" : path,
  });
  assert.equal(h.releases[0].status, "connected");
}
for (const status of [302, 401, 403]) {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response("", {
      status,
      headers: { location: "https://attacker.example/" },
    });
  });
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("reconnect-required"),
  );
  assert.equal(calls, 1);
  assert.equal(h.releases[0].status, "reconnect-required");
}
{
  const h = harness(async () => new Response("<html>Sign in</html>"));
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("reconnect-required"),
  );
}
{
  const h = harness(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("invalid-response"),
  );
}
{
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response("", {
      status: 429,
      headers: { "retry-after": "3600" },
    });
  });
  const start = Date.now();
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("rate-limited"),
  );
  assert.equal(calls, 1);
  assert.ok(h.releases[0].retryAt >= start + 3600000);
  assert.equal(retryAfterMs("garbage"), 2000);
  assert.equal(
    retryAfterMs(
      "Wed, 01 Jan 2025 00:01:00 GMT",
      Date.parse("2025-01-01T00:00:00Z"),
    ),
    60000,
  );
}
{
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response("{}");
  });
  for (const badPath of [
    "//attacker.example/sh/research/api/search",
    "https://attacker.example/",
    "/signin",
  ]) {
    await assert.rejects(
      h.request("ebayResearch", { path: badPath }),
      fails("invalid-response"),
    );
  }
  for (const timeoutMs of [-1, NaN, Infinity]) {
    await assert.rejects(
      h.request("ebayResearch", { path }, { timeoutMs }),
      fails("invalid-response"),
    );
  }
  await assert.rejects(
    h.request("ebayResearch", { path }, { signal: AbortSignal.abort() }),
    fails("cancelled"),
  );
  assert.equal(h.claims(), 0);
  assert.equal(calls, 0);
}
{
  const controller = new AbortController();
  const h = harness(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("secret headers")),
          { once: true },
        );
        controller.abort();
      }),
  );
  await assert.rejects(
    h.request("ebayResearch", { path }, { signal: controller.signal }),
    fails("cancelled"),
  );
  assert.equal(h.releases[0].status, "cancelled");
}
{
  const h = harness(async () => new Response("{}"), {
    release: async () => {
      throw new Error("private database detail");
    },
  });
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("unavailable"),
  );
}
validateAltConnection('{"data":{"me":{"id":"fixture"}}}');
assert.throws(
  () => validateAltConnection('{"data":{"me":null}}'),
  fails("reconnect-required"),
);
assert.throws(
  () =>
    validateAltConnection(
      '{"errors":[{"extensions":{"code":"UNAUTHENTICATED"}}]}',
    ),
  fails("reconnect-required"),
);
for (const body of [
  "null",
  "{}",
  '{"errors":[{"message":"schema changed"}]}',
]) {
  assert.throws(() => validateAltConnection(body), fails("invalid-response"));
}
validateEbayConnection(
  '{"_type":"PageErrorModule"}\n\n{"_type":"ResultsHeaderModule","tabs":[{"active":true}]}',
);
for (const body of [
  "null",
  "{}",
  '{"_type":"ResultsHeaderModule","tabs":{}}',
]) {
  assert.throws(() => validateEbayConnection(body), fails("invalid-response"));
}
assert.equal(
  validateCredential("alt", "Bearer token.value", ""),
  "token.value",
);
assert.throws(() =>
  validateCredential("ebayResearch", "cookie=value\r\nInjected: true", "agent"),
);
assert.throws(() => validateCredential("ebayResearch", "cookie=value", ""));

{
  let saved = 0;
  const action = createProviderConnectionsAction({
    save: async () => {
      saved++;
    },
    clear: async () => {},
    check: async () => {
      throw new Error("private provider response");
    },
  });
  const submit = (intent: string, origin = "http://localhost:5153") =>
    action({
      request: new Request("http://localhost:5153/slab-connections", {
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams({
          provider: "alt",
          intent,
          credential: "secret",
        }),
      }),
    });
  assert.equal(
    (await submit("save", "https://foreign.example")).init?.status,
    403,
  );
  assert.equal(saved, 0);
  assert.equal((await submit("save")).data.ok, true);
  assert.equal(saved, 1);
  const failed = await submit("check");
  assert.equal(failed.data.ok, false);
  assert.ok(!JSON.stringify(failed).includes("private provider"));
  assert.equal(
    failed.init?.headers &&
      new Headers(failed.init.headers).get("Cache-Control"),
    "no-store",
  );
}
{
  const action = createProviderConnectionsAction({
    save: async () => {},
    clear: async () => {},
    check: async () => {
      throw new ProviderRequestError("reconnect-required");
    },
  });
  const result = await action({
    request: new Request("http://localhost/slab-connections", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: new URLSearchParams({ provider: "alt", intent: "check" }),
    }),
  });
  assert.equal(result.data.ok, false);
  assert.equal(
    result.init?.status,
    200,
    "completed checks must revalidate the stored connection status",
  );
}
{
  let received = false;
  const server = createServer((_request, response) => {
    received = true;
    response.writeHead(200);
    response.write('{"data":');
    // Deliberately leave the response body open.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const h = harness((_url, init) =>
      fetch(`http://127.0.0.1:${address.port}`, init),
    );
    await assert.rejects(
      h.request("ebayResearch", { path }, { timeoutMs: 250 }),
      fails("cancelled"),
    );
    assert.equal(received, true);
    assert.equal(h.releases[0].status, "cancelled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
{
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "0" } });
  });
  await assert.rejects(
    h.request("ebayResearch", { path }),
    fails("rate-limited"),
  );
  assert.equal(calls, 3);
}
console.log(
  "PASS slab provider isolation, auth failures, bounds, cancellation, validation and masked actions",
);
