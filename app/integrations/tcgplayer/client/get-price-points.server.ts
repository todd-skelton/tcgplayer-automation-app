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
