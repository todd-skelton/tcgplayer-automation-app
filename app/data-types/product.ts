import type { Condition } from "../tcgplayer/types/Condition";
import type { Language } from "../tcgplayer/types/Language";
import type { Variant } from "../tcgplayer/types/Variant";

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
  skus: Sku[];
};

export type Sku = {
  sku: number;
  condition: Condition;
  variant: Variant;
  language: Language;
};
