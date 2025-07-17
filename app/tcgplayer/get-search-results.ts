import { post } from "~/httpClient";

export interface GetProductsRequestBody {
  algorithm?: string;
  from?: number;
  size?: number;
  filters?: Filters;
  listingSearch?: ListingSearch;
  context?: Context2;
  settings?: Settings;
  sort?: Sort;
}

export interface Filters {
  term?: Term;
  range?: Range;
  match?: Match;
}

export interface Term {
  productLineName: string[];
  setName: string[];
}

export interface Range {}

export interface Match {}

export interface ListingSearch {
  context: Context;
  filters: Filters2;
}

export interface Context {
  cart: Cart;
}

export interface Cart {}

export interface Filters2 {
  term: Term2;
  range: Range2;
  exclude: Exclude;
}

export interface Term2 {
  sellerStatus: string;
  channelId: number;
  sellerKey?: string[];
}

export interface Range2 {
  quantity: Quantity;
}

export interface Quantity {
  gte: number;
}

export interface Exclude {
  channelExclusion: number;
}

export interface Context2 {
  cart: Cart2;
  shippingCountry: string;
  userProfile: UserProfile;
}

export interface Cart2 {}

export interface UserProfile {
  productLineAffinity: string;
  priceAffinity: number;
}

export interface Settings {
  useFuzzySearch: boolean;
  didYouMean: DidYouMean;
}

export interface DidYouMean {}

export interface Sort {
  field: string;
  order: string;
}

export interface GetProductsResponse {
  errors: any[];
  results: Result[];
}

export interface Result {
  aggregations: Aggregations;
  results: Product[];
  algorithm: string;
  searchType: string;
  didYouMean: DidYouMean;
  totalResults: number;
  resultId: string;
}

export interface Aggregations {
  cardType: CardType[];
  stage: Stage[];
  rarityName: RarityName[];
  setName: SetName[];
  productTypeName: ProductTypeName[];
  productLineName: ProductLineName[];
  condition: Condition[];
  language: Language[];
  printing: Printing[];
}

export interface CardType {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface Stage {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface RarityName {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface SetName {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface ProductTypeName {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface ProductLineName {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface Condition {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface Language {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface Printing {
  urlValue: string;
  isActive: boolean;
  value: string;
  count: number;
}

export interface Product {
  listings: Listing[];
  shippingCategoryId: number;
  duplicate: boolean;
  productLineUrlName: string;
  productUrlName: string;
  productTypeId: number;
  rarityName: string;
  sealed: boolean;
  marketPrice: number;
  customAttributes: CustomAttributes;
  productName: string;
  setId: number;
  productId: number;
  score: number;
  setName: string;
  foilOnly: boolean;
  setUrlName: string;
  sellerListable: boolean;
  totalListings: number;
  productLineId: number;
  productStatusId: number;
  productLineName: string;
  maxFulfillableQuantity: number;
  lowestPrice?: number;
  lowestPriceWithShipping?: number;
}

export interface Listing {
  customData: CustomData;
  directProduct: boolean;
  goldSeller: boolean;
  listingId: number;
  channelId: number;
  conditionId: number;
  verifiedSeller: boolean;
  directInventory: number;
  rankedShippingPrice: number;
  productId: number;
  printing: string;
  languageAbbreviation: string;
  sellerName: string;
  sellerPrograms: string[];
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
  listedDate?: string;
  soldDate?: string;
}

export interface CustomData {
  customListingId?: number;
  images: string[];
  title?: string;
  description?: string;
  linkId?: string;
}

export interface CustomAttributes {
  description?: string;
  stage?: string;
  releaseDate: string;
  number: string;
  cardType: string[];
  retreatCost?: string;
  resistance?: string;
  rarityDbName: string;
  weakness?: string;
  flavorText: string;
  attack1?: string;
  hp?: string;
  attack2?: string;
  attack3: any;
  attack4: any;
}

export interface DidYouMean {}

export async function getProducts(
  body: GetProductsRequestBody
): Promise<GetProductsResponse> {
  const data = await post<GetProductsResponse>(
    `https://mp-search-api.tcgplayer.com/v1/search/request`,
    body
  );
  return data;
}

export async function getAllProducts(
  body: Omit<GetProductsRequestBody, "from">
): Promise<Product[]> {
  const size = (body.size ?? 24) > 24 ? 24 : body.size || 24;
  let from = 0;
  let listings: Product[] = [];
  let total = 0;

  do {
    const { results } = await getProducts({ ...body, from, size });
    const page = results[0];
    if (from === 0) total = page.totalResults;
    listings.push(...page.results);
    from += size;
  } while (listings.length < total);

  return listings;
}
