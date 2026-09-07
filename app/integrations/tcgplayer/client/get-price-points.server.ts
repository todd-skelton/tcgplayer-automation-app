import { mpGateway } from "../../../core/clients";

export interface GetPricePointsRequestBody {
  skuIds: number[];
}

export interface PricePoint {
  skuId: number;
  marketPrice: number;
  lowestPrice: number;
  highestPrice: number;
  priceCount: number;
  calculatedAt: string;
}

export async function getPricePoints(
  requestBody: GetPricePointsRequestBody,
  options?: { signal?: AbortSignal; retry?: boolean },
): Promise<PricePoint[]> {
  return mpGateway.post<PricePoint[]>(
    "/v1/pricepoints/marketprice/skus/search",
    requestBody,
    options,
  );
}

const MARKET_PRICE_BATCH_SIZE = 250;

export type PricePointsClient = (
  requestBody: GetPricePointsRequestBody,
  options?: { signal?: AbortSignal; retry?: boolean },
) => Promise<PricePoint[]>;

export type MarketPriceObservation = {
  marketPrice: number | null;
  calculatedAt: string;
};

export async function fetchMarketPriceObservationsBySku(
  skus: number[],
  pricePointsClient: PricePointsClient = getPricePoints,
): Promise<Map<number, MarketPriceObservation>> {
  const uniqueSkus = Array.from(new Set(skus));
  const observations = new Map<number, MarketPriceObservation>();

  for (
    let offset = 0;
    offset < uniqueSkus.length;
    offset += MARKET_PRICE_BATCH_SIZE
  ) {
    const pricePoints = await pricePointsClient({
      skuIds: uniqueSkus.slice(offset, offset + MARKET_PRICE_BATCH_SIZE),
    });

    for (const pricePoint of pricePoints) {
      observations.set(pricePoint.skuId, {
        marketPrice:
          Number.isFinite(pricePoint.marketPrice) && pricePoint.marketPrice > 0
            ? pricePoint.marketPrice
            : null,
        calculatedAt: pricePoint.calculatedAt,
      });
    }
  }

  return observations;
}

export async function fetchInventoryIntakeMarketObservation(
  sku: number,
  pricePointsClient: PricePointsClient = getPricePoints,
  deadlineMs = 3_000,
): Promise<MarketPriceObservation | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const pricePoints = await Promise.race([
      pricePointsClient(
        { skuIds: [sku] },
        { signal: controller.signal, retry: false },
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Inventory intake market lookup timed out"));
        }, deadlineMs);
      }),
    ]);
    const pricePoint = pricePoints.find((point) => point.skuId === sku);
    if (!pricePoint) return null;
    return {
      marketPrice:
        Number.isFinite(pricePoint.marketPrice) && pricePoint.marketPrice > 0
          ? pricePoint.marketPrice
          : null,
      calculatedAt: pricePoint.calculatedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Current market price by SKU, fetched in bounded batches. SKUs without a
 * positive market price are left out of the map.
 */
export async function fetchMarketPricesBySku(
  skus: number[],
  pricePointsClient: PricePointsClient = getPricePoints,
): Promise<Map<number, number>> {
  const marketPrices = new Map<number, number>();

  const observations = await fetchMarketPriceObservationsBySku(
    skus,
    pricePointsClient,
  );
  for (const [sku, observation] of observations) {
    if (observation.marketPrice !== null) {
      marketPrices.set(sku, observation.marketPrice);
    }
  }

  return marketPrices;
}
