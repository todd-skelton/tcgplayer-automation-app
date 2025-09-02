import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import type { Language } from "../../../integrations/tcgplayer/types/Language";
import type { Variant } from "../../../integrations/tcgplayer/types/Variant";

export type Product = {
  productTypeName: string;
  rarityName: string;
  sealed: boolean;
  productName: string;
  setId: number;
  setCode: string;
  productId: number;
  setName: string;
  productLineId: number;
  productStatusId: number;
  productLineName: string;
  skus: ProductSku[];
};

export type ProductSku = {
  sku: number;
  condition: Condition;
  variant: Variant;
  language: Language;
};
