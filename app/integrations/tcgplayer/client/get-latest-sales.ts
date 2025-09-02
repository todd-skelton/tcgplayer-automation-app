import { post } from "../../../core/httpClient";
import type { Condition } from "../types/Condition";
import type { Language } from "../types/Language";
import type { Variant } from "../types/Variant";

export enum ConditionId {
  NearMint = 1,
  LightlyPlayed = 2,
  ModeratelyPlayed = 3,
  HeavilyPlayed = 4,
  Damaged = 5,
}

export type PageBoolean = "Yes" | "";

export enum LanguageId {
  English = 1,
}

export enum VariantId {
  Holofoil = 11,
}

export type ListingType = "ListingWithoutPhotos" | "ListingWithPhotos" | "All";

export type GetLastSalesRequestParams = {
  id: number;
};

export type GetLastestSalesRequestBody = {
  conditions?: ConditionId[];
  languages?: LanguageId[];
  variants?: VariantId[];
  listingType?: ListingType;
  offset?: number;
  limit?: number;
};

export type Sale = {
  condition: Condition;
  variant: Variant;
  language: Language;
  quantity: number;
  title: string;
  listingType: ListingType;
  customListingId: string;
  purchasePrice: number;
  shippingPrice: number;
  orderDate: string;
};

export type GetLatestSalesResponse = {
  previousPage: PageBoolean;
  nextPage: PageBoolean;
  resultCount: number;
  totalResults: number;
  data: Sale[];
};

export async function getLatestSales(
  { id }: GetLastSalesRequestParams,
  body: GetLastestSalesRequestBody
): Promise<GetLatestSalesResponse> {
  const data = await post<GetLatestSalesResponse>(
    `https://mpapi.tcgplayer.com/v2/product/${id}/latestsales`,
    body
  );
  return data;
}

export async function getAllLatestSales(
  params: GetLastSalesRequestParams,
  body: GetLastestSalesRequestBody,
  maxSales?: number
): Promise<Sale[]> {
  const baseLimit = body.limit ?? 25;
  let offset = body.offset ?? 0;
  const allSales: Sale[] = [];

  while (maxSales === undefined || allSales.length < maxSales) {
    // Calculate how many more sales we need
    const remainingSales = maxSales ? maxSales - allSales.length : Infinity;
    const currentLimit = maxSales
      ? Math.min(baseLimit, remainingSales)
      : baseLimit;

    if (maxSales && remainingSales <= 0) break;

    const response = await getLatestSales(params, {
      ...body,
      offset,
      limit: currentLimit,
    });

    allSales.push(...response.data);

    // Break if no more pages
    if (response.nextPage !== "Yes") break;

    // Break if we have enough sales
    if (maxSales && allSales.length >= maxSales) break;

    offset += currentLimit;
  }

  return allSales;
}
