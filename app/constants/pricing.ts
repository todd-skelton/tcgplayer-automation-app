export const PRICING_CONSTANTS = {
  DEFAULT_PERCENTILE: 65,
  PERCENTILE_STEP: 10,
  MIN_PERCENTILE: 0,
  MAX_PERCENTILE: 100,
  SKIP_PREFIX: "C-",
  SUCCESS_RATE_THRESHOLD: {
    LOW: 70,
    HIGH: 90,
  },
} as const;

export const PERCENTILES = Array.from(
  {
    length:
      (PRICING_CONSTANTS.MAX_PERCENTILE - PRICING_CONSTANTS.MIN_PERCENTILE) /
        PRICING_CONSTANTS.PERCENTILE_STEP +
      1,
  },
  (_, i) => i * PRICING_CONSTANTS.PERCENTILE_STEP
);

export const FILE_CONFIG = {
  ACCEPT: ".csv",
  OUTPUT_PREFIX: "priced-listings-",
  MIME_TYPE: "text/csv",
} as const;
