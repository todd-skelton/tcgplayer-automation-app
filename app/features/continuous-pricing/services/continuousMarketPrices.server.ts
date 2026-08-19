import {
  getPricePoints,
  type GetPricePointsRequestBody,
  type PricePoint,
} from "~/integrations/tcgplayer/client/get-price-points.server";

const MARKET_PRICE_BATCH_SIZE = 250;

type PricePointsClient = (
  request: GetPricePointsRequestBody,
) => Promise<PricePoint[]>;

export async function fetchContinuousMarketPrices(
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
