import type { Condition } from "~/integrations/tcgplayer/types/Condition";

export interface PullSheetCsvRow {
  "Product Line": string;
  "Product Name": string;
  Condition: string;
  Number: string;
  Set: string;
  Rarity: string;
  Quantity: string;
  "Main Photo URL": string;
  "Set Release Date": string;
  SkuId: string;
  "Order Quantity": string;
}

export interface PullSheetItem {
  skuId: number;
  productLine: string;
  productName: string;
  condition: string;
  number: string;
  set: string;
  releaseYear?: string;
  rarity: string;
  quantity: number;
  orderQuantity: string;
  // Enriched from database lookup
  productId?: number;
  productLineId?: number;
  variant?: string;
  dbCondition?: Condition;
  found: boolean;
}

/** Per-unit prices shown on a pull sheet card when the caller knows what the card sold for. */
export interface PullSheetPriceBadge {
  soldPrice: number;
  marketPrice?: number;
  /** Shipping-only SKU aggregate. Kept optional for non-shipping pull sheets. */
  intakeMarketTotal?: number | null;
  intakeOrderedQuantity?: number;
  intakePriceKnownQuantity?: number;
  intakeDateKnownQuantity?: number;
  intakeWeightedDaysHeld?: number | null;
  intakeStatus?: string;
}
