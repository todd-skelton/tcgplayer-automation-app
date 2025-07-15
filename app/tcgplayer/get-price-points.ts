import { post } from "~/httpClient";

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
  requestBody: GetPricePointsRequestBody
): Promise<PricePoint[]> {
  return post<PricePoint[]>(
    "https://mpgateway.tcgplayer.com/v1/pricepoints/marketprice/skus/search",
    requestBody
  );
}
