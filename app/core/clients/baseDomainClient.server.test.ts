import assert from "node:assert/strict";
import type { AxiosResponse } from "axios";
import {
  ConcurrencyLimiter,
  observeSafeHttpResponse,
  RequestThrottler,
} from "./baseDomainClient.server";
import {
  DOMAIN_KEYS,
  DEFAULT_ADAPTIVE_CONFIG,
  type DomainRateLimitConfig,
} from "../config/httpConfig.shared";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function createDomainConfig(
  overrides: Partial<DomainRateLimitConfig> = {},
): DomainRateLimitConfig {
  return {
    requestDelayMs: 500,
    rateLimitCooldownMs: 10000,
    maxConcurrentRequests: 5,
    adaptiveEnabled: true,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 10000,
    learnedMinDelayMs: 200,
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "response observers receive bounded metadata and cannot fail a request",
    run: () => {
      const response = {
        status: 200,
        headers: {
          "content-type": "application/private+json; account=do-not-retain",
        },
        request: { _redirectable: { _redirectCount: 1 } },
      } as unknown as AxiosResponse<unknown>;
      let observed: unknown;

      assert.doesNotThrow(() =>
        observeSafeHttpResponse(response, (metadata) => {
          observed = metadata;
          throw new Error("observer failed");
        }),
      );
      assert.deepEqual(observed, {
        status: 200,
        contentType: "json",
        redirected: true,
      });
      assert.ok(!JSON.stringify(observed).includes("account"));
      assert.ok(!JSON.stringify(observed).includes("private"));
    },
  },
  {
    name: "RequestThrottler.recordSuccess uses the latest persisted delay between success thresholds",
    run: async () => {
      let currentConfig = createDomainConfig();
      const updates: Array<{
        requestDelayMs: number;
        learnedMinDelayMs: number;
      }> = [];

      const throttler = new RequestThrottler(
        DOMAIN_KEYS.ORDER_MANAGEMENT_API,
        async () => currentConfig,
        async (requestDelayMs: number, learnedMinDelayMs: number) => {
          updates.push({ requestDelayMs, learnedMinDelayMs });
          currentConfig = {
            ...currentConfig,
            requestDelayMs,
            learnedMinDelayMs,
          };
        },
        async () => {},
      );

      for (let index = 0; index < DEFAULT_ADAPTIVE_CONFIG.successThreshold; index++) {
        await throttler.recordSuccess(DEFAULT_ADAPTIVE_CONFIG);
      }

      for (let index = 0; index < DEFAULT_ADAPTIVE_CONFIG.successThreshold; index++) {
        await throttler.recordSuccess(DEFAULT_ADAPTIVE_CONFIG);
      }

      assert.deepEqual(updates, [
        { requestDelayMs: 400, learnedMinDelayMs: 200 },
        { requestDelayMs: 300, learnedMinDelayMs: 200 },
      ]);
    },
  },
  {
    name: "aborted requests leave limiter and throttle queues",
    run: async () => {
      const limiter = new ConcurrencyLimiter();
      await limiter.acquire(1);
      const limiterAbort = new AbortController();
      const waitingForLimiter = limiter.acquire(1, limiterAbort.signal);
      limiterAbort.abort();
      await assert.rejects(waitingForLimiter, { name: "AbortError" });
      limiter.release();
      await limiter.acquire(1);
      limiter.release();

      const delayedStarts: Array<() => void> = [];
      const throttler = new RequestThrottler(
        DOMAIN_KEYS.MP_GATEWAY,
        async () => createDomainConfig({ requestDelayMs: 1_000 }),
        async () => undefined,
        () => new Promise<void>((resolve) => delayedStarts.push(resolve)),
      );
      await throttler.waitToStart();
      const throttleAbort = new AbortController();
      const waitingForThrottle = throttler.waitToStart(throttleAbort.signal);
      throttleAbort.abort();
      await assert.rejects(waitingForThrottle, { name: "AbortError" });
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} domain HTTP client tests.`);
}
