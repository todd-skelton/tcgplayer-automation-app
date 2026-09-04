export const PRICING_CONSTANTS = {
  DEFAULT_PERCENTILE: 65,
  PERCENTILE_STEP: 5,
  MIN_PERCENTILE: 5,
  MAX_PERCENTILE: 95,
  SKIP_PREFIX: "C-",
  MIN_PRICE_MULTIPLIER: 80 / 85,
  MIN_PRICE_CONSTANT: 0.1,
  /** Orders at or above this ship free; smaller orders pay the small-order fee. */
  FREE_SHIPPING_THRESHOLD: 5,
  SMALL_ORDER_SHIPPING_FEE: 1.49,
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
  (_, i) =>
    PRICING_CONSTANTS.MIN_PERCENTILE + i * PRICING_CONSTANTS.PERCENTILE_STEP,
);

export const FILE_CONFIG = {
  ACCEPT: ".csv",
  OUTPUT_PREFIX: "priced-listings-",
  MIME_TYPE: "text/csv",
} as const;
