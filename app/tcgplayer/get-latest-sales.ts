import { post } from "~/httpClient";
import type { Condition } from "./types/Condition";
import type { Language } from "./types/Language";
import type { Variant } from "./types/Variant";

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
  body: Omit<GetLastestSalesRequestBody, "offset">
): Promise<Sale[]> {
  const limit = body.limit ?? 25;
  let offset = 0;
  let allSales: Sale[] = [];
  let hasNext = true;

  while (hasNext) {
    const response = await getLatestSales(params, { ...body, offset, limit });
    allSales = allSales.concat(response.data);
    hasNext = response.nextPage === "Yes";
    offset += limit;
  }

  return allSales;
}
