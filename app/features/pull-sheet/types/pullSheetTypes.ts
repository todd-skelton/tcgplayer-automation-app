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
