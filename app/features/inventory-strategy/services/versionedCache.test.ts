import assert from "node:assert/strict";
import { createVersionedCache } from "./versionedCache";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const cache = createVersionedCache<string>("test");
let builds = 0;
let release: (value: string) => void = () => {};
let fail: (error: Error) => void = () => {};
const build = () => {
  builds += 1;
  return new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
};

const first = cache.read("seller", "config-a", "v1", build);
const again = cache.read("seller", "config-a", "v1", build);
assert.equal(builds, 1, "concurrent first reads share one build");
release("built-1");
assert.equal(await first, "built-1", "the first read waits for its build");
assert.equal(await again, "built-1");
assert.equal(
  await cache.read("seller", "config-a", "v1", build),
  "built-1",
  "an unchanged version is served from cache",
);
assert.equal(builds, 1);

const stale = cache.read("seller", "config-a", "v2", build);
assert.equal(builds, 2, "a changed version starts a rebuild");
assert.equal(await stale, "built-1", "and serves the last value meanwhile");
assert.equal(
  await cache.read("seller", "config-a", "v3", build),
  "built-1",
  "a version that moves during a build does not start another",
);
assert.equal(builds, 2);
release("built-2");
await settle();
assert.equal(
  await cache.read("seller", "config-a", "v2", build),
  "built-2",
  "the finished build is served at its version",
);
const catchUp = cache.read("seller", "config-a", "v3", build);
assert.equal(
  builds,
  3,
  "the next read after a build catches up to the newer version",
);
assert.equal(await catchUp, "built-2");
const logged: unknown[][] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args);
};
fail(new Error("source down"));
await settle();
console.error = consoleError;
assert.equal(logged.length, 1, "a failed rebuild is logged");
assert.equal(
  await cache.read("seller", "config-a", "v2", build),
  "built-2",
  "a failed rebuild keeps serving the last value",
);
assert.equal(builds, 3);
assert.equal(
  await cache.read("seller", "config-a", "v3", build).then(
    () => builds,
    () => -1,
  ),
  4,
  "and the next read retries it",
);
release("built-3");
await settle();

const reconfigured = cache.read("seller", "config-b", "v3", build);
assert.equal(builds, 5, "a changed identity rebuilds");
release("built-4");
assert.equal(
  await reconfigured,
  "built-4",
  "and waits for the build instead of serving the old identity",
);

const rejected = cache.read("other", "config-a", "v1", build);
fail(new Error("source down"));
await assert.rejects(
  rejected,
  /source down/,
  "a first build that fails rejects",
);
const retried = cache.read("other", "config-a", "v1", build);
assert.equal(builds, 7, "and the next read builds again");
release("built-5");
assert.equal(await retried, "built-5");

console.log(
  "PASS versioned cache serves the last value while a newer version builds",
);
