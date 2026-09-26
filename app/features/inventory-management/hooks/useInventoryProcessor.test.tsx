import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  useInventoryProcessor,
  type InventoryProcessorReturn,
} from "./useInventoryProcessor";
import { PENDING_INTAKE_REQUEST_KEY } from "../services/pendingIntakeRequest";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";

// Run separately: this test installs a controlled browser transport and session store.
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
environment.IS_REACT_ACT_ENVIRONMENT = true;
const saved = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
});
let hook: InventoryProcessorReturn;
let renderer: ReactTestRenderer | undefined;
function Harness() {
  hook = useInventoryProcessor();
  return null;
}
const metadata = { productId: 1, setId: 1, productLineId: 3 };
let serverQuantity = 0;
let failMutation = false;
let loseQueueResponse = false;
let releaseMutation: (() => void) | null = null;
let mutationWait: Promise<void> | null = null;
const batches = new Map<string, { batchNumber: number }>();
const queueBodies: Array<{ requestId: string; workflow: string }> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url === "/api/pricing-config")
    return Response.json(DEFAULT_SERVER_PRICING_CONFIG);
  if (url === "/api/pending-inventory") {
    if (!init)
      return Response.json(
        serverQuantity
          ? [{ sku: 1, quantity: serverQuantity, ...metadata }]
          : [],
      );
    if (mutationWait) await mutationWait;
    if (failMutation)
      return Response.json({ error: "edit conflict" }, { status: 409 });
    const body = JSON.parse(String(init.body));
    serverQuantity =
      body.operation === "set" ? body.quantity : serverQuantity + body.quantity;
    return Response.json({ quantity: serverQuantity });
  }
  if (url === "/api/inventory-intake-runs") {
    const body = JSON.parse(String(init?.body));
    queueBodies.push(body);
    if (!batches.has(body.requestId)) {
      assert.deepEqual(body.expectedInventory, [
        { sku: 1, quantity: serverQuantity },
      ]);
      batches.set(body.requestId, { batchNumber: batches.size + 1 });
      serverQuantity = 0;
    }
    if (loseQueueResponse) throw new Error("response lost");
    return Response.json(batches.get(body.requestId));
  }
  throw new Error(`Unexpected URL: ${url}`);
}) as typeof fetch;

try {
  await act(async () => {
    renderer = create(<Harness />);
  });
  assert.equal(hook!.intakeBlocked, false);
  mutationWait = new Promise((resolve) => {
    releaseMutation = resolve;
  });
  let handoff: Promise<unknown>;
  await act(async () => {
    await hook!.adjustPendingInventory(1, 3, metadata);
  });
  await act(async () => {
    handoff = hook!.createBatchFromPendingInventory(undefined, "publish");
  });
  assert.equal(hook!.intakeBlocked, true);
  assert.equal(queueBodies.length, 0, "handoff waits for saved edits");
  await act(async () => {
    await hook!.adjustPendingInventory(1, 5, metadata);
    releaseMutation!();
    await handoff;
  });
  mutationWait = null;
  assert.equal(queueBodies.length, 1);
  assert.equal(
    serverQuantity,
    0,
    "entry cannot sneak into a handoff in progress",
  );
  assert.equal(hook!.intakeBlocked, false);
  assert.equal(hook!.pendingInventory.length, 0);

  await act(async () => {
    await hook!.adjustPendingInventory(1, 2, metadata);
  });
  loseQueueResponse = true;
  await act(async () => {
    await assert.rejects(
      hook!.createBatchFromPendingInventory(undefined, "price_only"),
      /response/,
    );
  });
  const originalRequest = JSON.parse(saved.get(PENDING_INTAKE_REQUEST_KEY)!);
  assert.equal(originalRequest.workflow, "price_only");
  assert.equal(hook!.intakeBlocked, true);
  await act(async () => {
    renderer!.unmount();
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  assert.equal(hook!.hasPendingIntakeRequest, true);
  assert.equal(hook!.intakeBlocked, true);
  loseQueueResponse = false;
  await act(async () => {
    await hook!.createBatchFromPendingInventory(undefined, "publish");
  });
  assert.equal(
    queueBodies.at(-1)!.workflow,
    "price_only",
    "recovery cannot widen permission",
  );
  assert.equal(queueBodies.at(-1)!.requestId, originalRequest.requestId);
  assert.equal(batches.size, 2);
  assert.equal(saved.size, 0);

  failMutation = true;
  await act(async () => {
    await hook!.adjustPendingInventory(1, 2, metadata);
  });
  const before = queueBodies.length;
  await act(async () => {
    await assert.rejects(
      hook!.createBatchFromPendingInventory(undefined, "publish"),
      /edit failed/,
    );
  });
  assert.equal(
    queueBodies.length,
    before,
    "failed inventory edits require review before any handoff",
  );
  console.log(
    "PASS inventory hook save barrier, entry lock, uncertain response recovery across reload, original permissions, and failed-edit guard",
  );
} finally {
  await act(async () => {
    renderer?.unmount();
  });
  globalThis.fetch = originalFetch;
  if (originalStorage)
    Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  delete environment.IS_REACT_ACT_ENVIRONMENT;
}
