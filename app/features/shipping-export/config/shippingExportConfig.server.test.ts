import assert from "node:assert/strict";
import { applyEnvironmentEasyPostMode } from "./shippingExportConfig.server";
import { DEFAULT_SHIPPING_EXPORT_CONFIG } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => void;
};

const originalNodeEnv = process.env.NODE_ENV;

const testCases: TestCase[] = [
  {
    name: "applyEnvironmentEasyPostMode forces test mode outside production",
    run: () => {
      process.env.NODE_ENV = "development";

      const config = applyEnvironmentEasyPostMode({
        ...DEFAULT_SHIPPING_EXPORT_CONFIG,
        easypostMode: "production",
      });

      assert.equal(config.easypostMode, "test");
    },
  },
  {
    name: "applyEnvironmentEasyPostMode forces production mode in production",
    run: () => {
      process.env.NODE_ENV = "production";

      const config = applyEnvironmentEasyPostMode({
        ...DEFAULT_SHIPPING_EXPORT_CONFIG,
        easypostMode: "test",
      });

      assert.equal(config.easypostMode, "production");
    },
  },
];

let failures = 0;

try {
  for (const testCase of testCases) {
    try {
      testCase.run();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${testCase.name}`);
      console.error(error);
    }
  }
} finally {
  process.env.NODE_ENV = originalNodeEnv;
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} shipping export config server tests.`);
}
