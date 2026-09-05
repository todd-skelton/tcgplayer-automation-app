import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { Variant } from "~/integrations/tcgplayer/types/Variant";
import type { ConditionNormalizationDetail } from "~/core/types/pricing";
import type {
  ActivePricingPolicy,
  PricingDecision,
} from "~/core/types/pricingPolicy";

export type ProductPriceMatrixSearchScope = "set" | "allSets";

export interface ProductPriceMatrixProduct {
  productId: number;
  productLineId: number;
  productLineName: string;
  productName: string;
  displayName: string;
  productTypeName: string;
  rarityName: string;
  sealed: boolean;
  setId: number;
  setCode: string;
  setName: string;
  setReleaseDate?: string;
  cardNumber?: string | null;
  skuCount: number;
  conditions: Condition[];
  variants: Variant[];
  languages: string[];
}

export interface ProductPriceMatrixProductsResponse {
  products: ProductPriceMatrixProduct[];
}

export interface ProductPriceMatrixRequest {
  productId: number;
  productLineId: number;
  language?: string;
  includeSuggestedPrices?: boolean;
}

/** The store's own listing of a SKU, from the continuous pricing inventory. */
export interface ProductPriceMatrixListing {
  price: number | null;
  quantity: number;
  inStock: boolean;
}

export interface ProductPriceMatrixCell {
  sku: number;
  condition: Condition;
  variant: Variant;
  language: string;
  tcgMarketPrice: number | null;
  lowestSalePrice: number | null;
  highestSalePrice: number | null;
  saleCount: number;
  priceCalculatedAt?: string;
  listing: ProductPriceMatrixListing | null;
  /** The active policy's price before the floor. */
  suggestedPrice: number | null;
  /** What the store would list at: the active policy's price after the floor. */
  sellAtPrice: number | null;
  /** The sell-at price clamped so no condition sits above a better one. */
  ladderPrice: number | null;
  /** The market price clamped the same way. */
  marketLadderPrice: number | null;
  /** True when the raw sell-at price sat above a better condition's. */
  aboveBetterCondition: boolean;
  estimatedTimeToSellDays?: number;
  pricingDecision?: PricingDecision;
  /** The percentile policy's decision beside the active one, when they differ. */
  shadowPricingDecision?: PricingDecision;
  conditionNormalization?: ConditionNormalizationDetail;
  warnings: string[];
  errors: string[];
}

export interface ProductPriceMatrixResponse {
  product: ProductPriceMatrixProduct;
  selectedLanguage?: string;
  availableLanguages: string[];
  conditions: Condition[];
  variants: Variant[];
  cells: ProductPriceMatrixCell[];
  suggestedPricesIncluded: boolean;
  /** The policy the sell-at prices came from. */
  policy?: ActivePricingPolicy;
  /** True when the store's own listings were looked up. */
  listingsIncluded: boolean;
  pricedAt: string;
}
