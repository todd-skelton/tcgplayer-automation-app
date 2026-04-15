import type {
  EasyPostEnvironmentStatus,
  EasyPostMode,
} from "../types/shippingExport";

function getNormalizedEnvValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getEasyPostEnvironmentStatus(): EasyPostEnvironmentStatus {
  return {
    hasTestApiKey: getNormalizedEnvValue("EASYPOST_TEST_API_KEY") !== null,
    hasProductionApiKey:
      getNormalizedEnvValue("EASYPOST_PRODUCTION_API_KEY") !== null,
  };
}

export function getDefaultEasyPostMode(): EasyPostMode {
  return process.env.NODE_ENV === "production" ? "production" : "test";
}

export function getEasyPostApiKey(mode: EasyPostMode): string {
  const envVarName =
    mode === "test" ? "EASYPOST_TEST_API_KEY" : "EASYPOST_PRODUCTION_API_KEY";
  const apiKey = getNormalizedEnvValue(envVarName);

  if (!apiKey) {
    throw new Error(`Missing ${envVarName} for EasyPost ${mode} mode.`);
  }

  return apiKey;
}
