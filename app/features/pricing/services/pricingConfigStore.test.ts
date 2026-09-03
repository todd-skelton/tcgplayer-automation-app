import assert from "node:assert/strict";
import {
  DEFAULT_SERVER_PRICING_CONFIG,
  type ServerPricingConfig,
} from "../types/config";
import { createPricingConfigStore } from "./pricingConfigStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An api whose requests stay pending until the test answers them. */
function fakeApi() {
  const loads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const saves: Array<{
    config: ServerPricingConfig;
    reply: ReturnType<typeof deferred<unknown>>;
  }> = [];
  return {
    loads,
    saves,
    api: {
      load: () => {
        const reply = deferred<unknown>();
        loads.push(reply);
        return reply.promise;
      },
      save: (config: ServerPricingConfig) => {
        const reply = deferred<unknown>();
        saves.push({ config, reply });
        return reply.promise;
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const withHurdle =
  (dailyReturnHurdle: number) =>
  (prev: ServerPricingConfig): ServerPricingConfig => ({
    ...prev,
    pricing: {
      ...prev.pricing,
      profitPerDay: { ...prev.pricing.profitPerDay, dailyReturnHurdle },
    },
  });
const hurdleOf = (config: ServerPricingConfig) =>
  config.pricing.profitPerDay.dailyReturnHurdle;

{
  // Quick edits apply at once and are saved one request at a time, newest next.
  const { saves, api } = fakeApi();
  const store = createPricingConfigStore(api);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.update(withHurdle(0.01));
  store.update(withHurdle(0.02));
  store.update(withHurdle(0.03));
  assert.equal(hurdleOf(store.get()), 0.03, "edits apply immediately");
  assert.equal(notifications, 3, "each edit notifies subscribers");
  assert.equal(saves.length, 1, "one request is in flight at a time");
  assert.equal(hurdleOf(saves[0].config), 0.01);

  saves[0].reply.resolve(saves[0].config);
  await settle();
  assert.equal(
    hurdleOf(store.get()),
    0.03,
    "a response older than a queued edit is not applied",
  );
  assert.equal(saves.length, 2, "only the newest edit is sent next");
  assert.equal(hurdleOf(saves[1].config), 0.03);

  saves[1].reply.resolve(withHurdle(0.03)(DEFAULT_SERVER_PRICING_CONFIG));
  await settle();
  assert.equal(saves.length, 2, "nothing is left to send");
  assert.equal(notifications, 4, "the server's answer is published once");
}

{
  // A failed save keeps the edit, sends the next one, and never reloads over it.
  const { loads, saves, api } = fakeApi();
  const store = createPricingConfigStore(api);
  store.update(withHurdle(0.04));
  saves[0].reply.reject(new Error("offline"));
  await settle();
  assert.equal(hurdleOf(store.get()), 0.04, "a failed save keeps the edit");
  store.update(withHurdle(0.05));
  assert.equal(saves.length, 2, "the next edit is sent after a failure");
  await store.load();
  assert.equal(loads.length, 0, "an edited store does not load over itself");
}

{
  // A load answered after an edit is discarded, whichever finishes first.
  const early = fakeApi();
  const editedDuringLoad = createPricingConfigStore(early.api);
  void editedDuringLoad.load();
  editedDuringLoad.update(withHurdle(0.06));
  early.loads[0].resolve(DEFAULT_SERVER_PRICING_CONFIG);
  await settle();
  assert.equal(
    hurdleOf(editedDuringLoad.get()),
    0.06,
    "a load answered while the save is in flight is discarded",
  );

  const late = fakeApi();
  const savedBeforeLoad = createPricingConfigStore(late.api);
  void savedBeforeLoad.load();
  savedBeforeLoad.update(withHurdle(0.07));
  late.saves[0].reply.resolve(late.saves[0].config);
  await settle();
  late.loads[0].resolve(DEFAULT_SERVER_PRICING_CONFIG);
  await settle();
  assert.equal(
    hurdleOf(savedBeforeLoad.get()),
    0.07,
    "a load answered after the save completed is discarded",
  );
}

{
  // The server copy is loaded once and then served.
  let loadCount = 0;
  const store = createPricingConfigStore({
    load: async () => {
      loadCount += 1;
      return withHurdle(0.02)(DEFAULT_SERVER_PRICING_CONFIG);
    },
    save: async (config) => config,
  });
  await Promise.all([store.load(), store.load()]);
  await store.load();
  assert.equal(loadCount, 1, "further loads are free");
  assert.equal(
    hurdleOf(store.get()),
    0.02,
    "the loaded configuration is served",
  );
}

console.log(
  "PASS pricing config store applies edits at once and saves them newest last",
);
