import { get } from "../../../core/httpClient";

export type Range = "annual" | "semiannual" | "quarter" | "month";

export type GetPriceHistoryRequestParams = {
  id: number;
  range: Range;
};

export interface GetPriceHistoryResponse {
  count: number;
  result: Result[];
}

export interface Result {
  skuId: string;
  variant: string;
  language: string;
  condition: string;
  averageDailyQuantitySold: string;
  averageDailyTransactionCount: string;
  totalQuantitySold: string;
  totalTransactionCount: string;
  trendingMarketPricePercentages: TrendingMarketPricePercentages;
  buckets: Bucket[];
}

export interface TrendingMarketPricePercentages {}

export interface Bucket {
  marketPrice: string;
  quantitySold: string;
  lowSalePrice: string;
  lowSalePriceWithShipping: string;
  highSalePrice: string;
  highSalePriceWithShipping: string;
  transactionCount: string;
  bucketStartDate: string;
}

export async function getPriceHistory({
  id,
  range,
}: GetPriceHistoryRequestParams): Promise<GetPriceHistoryResponse> {
  const url = `https://infinite-api.tcgplayer.com/price/history/${id}/detailed?range=${range}`;
  return get<GetPriceHistoryResponse>(url);
}
