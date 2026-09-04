import {
  fetchMarketPricesBySku,
  getPricePoints,
  type PricePointsClient,
} from "~/integrations/tcgplayer/client/get-price-points.server";

export async function fetchContinuousMarketPrices(
  skus: number[],
  pricePointsClient: PricePointsClient = getPricePoints,
): Promise<Map<number, number>> {
  return fetchMarketPricesBySku(skus, pricePointsClient);
}
