import { post } from "../../../core/httpClient";
import type { Condition } from "../types/Condition";
import type { Language } from "../types/Language";
import type { Variant } from "../types/Variant";

export type AggregationType =
  | "listingType"
  | "condition"
  | "language"
  | "quantity"
  | "printing";

export type ShippingCountry = "US";

export type Cart = {};

export type Context = {
  shippingCountry?: ShippingCountry;
  cart?: Cart;
};

export type ChannelExclusion = 0;

export type Exclude = {
  channelExclusion?: ChannelExclusion;
};

export type Quantity = {
  gte?: number;
};

export type Range = {
  quantity?: Quantity;
};

export type ListingType = "standard" | "custom";

export type SellerStatus = "Live";

export type ChannelId = 0;

export type Term = {
  channelId?: ChannelId;
  condition?: Condition[];
  language?: Language[];
  listingType?: ListingType[];
  printing?: Variant[];
  sellerStatus?: SellerStatus;
  "verified-seller"?: boolean;
};

export type Filters = {
  exclude?: Exclude;
  range?: Range;
  term?: Term;
};

export type Field = "price+shipping" | "price";
export type Order = "asc";

export type Sort = {
  field?: Field;
  order?: Order;
};

export type GetListingsRequestParams = {
  id: number;
};

export type GetListingsRequestBody = {
  aggregations?: AggregationType[];
  context?: Context;
  filters?: Filters;
  from?: number;
  size?: number;
  sort?: Sort;
};

export interface GetListingsResponse {
  errors: any[];
  results: Result[];
}

export interface Result {
  totalResults: number;
  resultId: string;
  aggregations: Aggregations;
  results: Listing[];
}

export interface Aggregations {
  condition?: Aggregation[];
  quantity?: Aggregation[];
  listingType?: Aggregation[];
  language?: Aggregation[];
  printing?: Aggregation[];
}

export interface Aggregation {
  value: string;
  count: number;
}

export interface Listing {
  directProduct: boolean;
  goldSeller: boolean;
  listingId: number;
  channelId: number;
  conditionId: number;
  listedDate?: string;
  verifiedSeller: boolean;
  directInventory: number;
  rankedShippingPrice: number;
  productId: number;
  printing: string;
  languageAbbreviation: string;
  sellerName: string;
  forwardFreight: boolean;
  sellerShippingPrice: number;
  language: string;
  shippingPrice: number;
  condition: string;
  languageId: number;
  score: number;
  directSeller: boolean;
  productConditionId: number;
  sellerId: string;
  listingType: string;
  sellerRating: number;
  sellerSales: string;
  quantity: number;
  sellerKey: string;
  price: number;
  customData: CustomData;
  soldDate?: string;
}

export interface CustomData {
  images: string[];
  title?: string;
  description?: string;
  linkId?: string;
}

export async function getListings(
  { id }: GetListingsRequestParams,
  body: GetListingsRequestBody
): Promise<GetListingsResponse> {
  const data = await post<GetListingsResponse>(
    `https://mp-search-api.tcgplayer.com/v1/product/${id}/listings`,
    body
  );
  return data;
}

export async function getAllListings(
  params: GetListingsRequestParams,
  body: Omit<GetListingsRequestBody, "from">,
  maxPrice?: number
): Promise<Listing[]> {
  const size = body.size ?? 50;
  let from = 0;
  let listings: Listing[] = [];
  let total = 0;

  do {
    const { results } = await getListings(params, { ...body, from, size });
    const page = results[0];
    if (from === 0) total = page.totalResults;

    // Filter out listings above maxPrice if specified
    const pageListings =
      maxPrice !== undefined
        ? page.results.filter(
            (listing) => listing.price + listing.sellerShippingPrice <= maxPrice
          )
        : page.results;

    listings.push(...pageListings);
    from += size;

    // Early termination: if we got fewer filtered results than expected and we have a maxPrice,
    // it means we've hit listings above our price threshold
    if (maxPrice !== undefined && pageListings.length < page.results.length) {
      console.log(
        `getAllListings: Early termination at price threshold $${maxPrice.toFixed(
          2
        )} after ${listings.length} listings`
      );
      break;
    }
  } while (listings.length < total && from < total);

  return listings;
}
