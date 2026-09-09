import assert from "node:assert/strict";
import type { AxiosResponse } from "axios";
import {
  ConcurrencyLimiter,
  DomainHttpClient,
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
    name: "DomainHttpClient.post exposes bounded metadata without changing request behavior",
    run: async () => {
      const client = new DomainHttpClient(
        DOMAIN_KEYS.MP_SEARCH_API,
        "https://synthetic.invalid",
      );
      let requestOptions: unknown;
      let maxRetries: number | undefined;
      let observed: unknown;
      const internals = client as unknown as {
        axiosClient: {
          post<T>(
            path: string,
            data: unknown,
            options: unknown,
          ): Promise<AxiosResponse<T>>;
        };
        executeWithRetry<T>(
          method: string,
          path: string,
          request: () => Promise<AxiosResponse<T>>,
          logContext: unknown,
          retries: number,
        ): Promise<T>;
      };
      internals.axiosClient = {
        async post<T>(_path: string, _data: unknown, options: unknown) {
          requestOptions = options;
          return {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type":
                "application/private+json; account=do-not-retain",
            },
            request: { _redirectable: { _redirectCount: 1 } },
            config: { headers: {} },
            data: { StagedPricingUploadId: 16104570 } as T,
          } as AxiosResponse<T>;
        },
      };
      internals.executeWithRetry = async <T>(
        _method: string,
        _path: string,
        request: () => Promise<AxiosResponse<T>>,
        _logContext: unknown,
        retries: number,
      ) => {
        maxRetries = retries;
        return (await request()).data;
      };

      const result = await client.post<{ StagedPricingUploadId: number }>(
        "/synthetic-initialize",
        new URLSearchParams({ filename: "synthetic.csv", type: "Pricing" }),
        {
          retry: false,
          observeResponse(metadata) {
            observed = metadata;
            throw new Error("synthetic observer failure");
          },
        },
      );

      assert.deepEqual(result, { StagedPricingUploadId: 16104570 });
      assert.equal(maxRetries, 0);
      assert.deepEqual(requestOptions, {});
      assert.deepEqual(observed, {
        status: 200,
        contentType: "json",
        redirected: true,
      });
      assert.ok(!JSON.stringify(observed).includes("account"));
      assert.ok(!JSON.stringify(observed).includes("private"));

      internals.axiosClient = {
        async post<T>() {
          throw Object.assign(new Error("synthetic rejected response"), {
            isAxiosError: true,
            response: {
              status: 403,
              headers: { "content-type": "text/html; private=discard" },
              request: { _redirectable: { _redirectCount: 0 } },
              config: { headers: {} },
              data: "private body",
            } as AxiosResponse<T>,
          });
        },
      };
      observed = undefined;
      await assert.rejects(
        client.post("/synthetic-rejection", undefined, {
          retry: false,
          observeResponse(metadata) {
            observed = metadata;
          },
        }),
        /synthetic rejected response/,
      );
      assert.deepEqual(observed, {
        status: 403,
        contentType: "html",
        redirected: false,
      });
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
