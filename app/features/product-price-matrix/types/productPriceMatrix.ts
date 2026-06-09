import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { Variant } from "~/integrations/tcgplayer/types/Variant";
import type { PricingPercentileDetail } from "~/core/types/pricing";

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
  suggestedPrice: number | null;
  marketplacePrice: number | null;
  percentileUsed?: number;
  historicalSalesVelocityDays?: number;
  estimatedTimeToSellDays?: number;
  salesCountForHistorical?: number;
  listingsCountForEstimated?: number;
  percentiles?: PricingPercentileDetail[];
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
  pricedAt: string;
}
