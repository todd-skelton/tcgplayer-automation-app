import assert from "node:assert/strict";
import {
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
