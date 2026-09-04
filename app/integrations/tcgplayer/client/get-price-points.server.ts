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
): Promise<PricePoint[]> {
  return mpGateway.post<PricePoint[]>(
    "/v1/pricepoints/marketprice/skus/search",
    requestBody,
  );
}

const MARKET_PRICE_BATCH_SIZE = 250;

export type PricePointsClient = (
  requestBody: GetPricePointsRequestBody,
) => Promise<PricePoint[]>;

/**
 * Current market price by SKU, fetched in bounded batches. SKUs without a
 * positive market price are left out of the map.
 */
export async function fetchMarketPricesBySku(
  skus: number[],
  pricePointsClient: PricePointsClient = getPricePoints,
): Promise<Map<number, number>> {
  const uniqueSkus = Array.from(new Set(skus));
  const marketPrices = new Map<number, number>();

  for (
    let offset = 0;
    offset < uniqueSkus.length;
    offset += MARKET_PRICE_BATCH_SIZE
  ) {
    const pricePoints = await pricePointsClient({
      skuIds: uniqueSkus.slice(offset, offset + MARKET_PRICE_BATCH_SIZE),
    });

    for (const pricePoint of pricePoints) {
      if (pricePoint.marketPrice > 0) {
        marketPrices.set(pricePoint.skuId, pricePoint.marketPrice);
      }
    }
  }

  return marketPrices;
}
