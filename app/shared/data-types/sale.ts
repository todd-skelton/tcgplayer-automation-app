import type { Condition } from "../../integrations/tcgplayer/types/Condition";
import type { Language } from "../../integrations/tcgplayer/types/Language";
import type { Variant } from "../../integrations/tcgplayer/types/Variant";

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
