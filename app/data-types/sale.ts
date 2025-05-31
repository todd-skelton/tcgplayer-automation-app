import type { Condition } from "../tcgplayer/types/Condition";
import type { Language } from "../tcgplayer/types/Language";
import type { Variant } from "../tcgplayer/types/Variant";

export type Sale = {
  productId: number;
  sku: number;
  condition: Condition;
  variant: Variant;
  language: Language;
  quantity: number;
  title: string;
  customListingId: string;
  purchasePrice: number;
  shippingPrice: number;
  orderDate: string;
};
