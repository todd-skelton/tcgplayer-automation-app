import { get } from "../../../core/httpClient";
import type { Condition } from "../types/Condition";
import type { Language } from "../types/Language";
import type { Variant } from "../types/Variant";

interface Result {
  customListings: number;
  shippingCategoryId: number;
  duplicate: boolean;
  productLineUrlName: string;
  productTypeName: string;
  productUrlName: string;
  productTypeId: number;
  rarityName: string;
  sealed: boolean;
  marketPrice: number;
  customAttributes: CustomAttributes;
  lowestPriceWithShipping: number;
  productName: string;
  setId: number;
  setCode: string;
  productId: number;
  imageCount: number;
  score: number;
  setName: string;
  sellers: number;
  foilOnly: boolean;
  setUrlName: string;
  sellerListable: boolean;
  productLineId: number;
  productStatusId: number;
  productLineName: string;
  maxFulfillableQuantity: number;
  normalOnly: boolean;
  listings: number;
  lowestPrice: number;
  medianPrice: any;
  formattedAttributes: FormattedAttributes;
  skus: Sku[];
}

interface CustomAttributes {
  description: string;
  attack2: string;
  stage: string;
  detailNote: string;
  energyType: string[];
  releaseDate: string;
  number: string;
  cardType: string[];
  retreatCost: string;
  cardTypeB: string;
  resistance: any;
  rarityDbName: string;
  weakness: any;
  flavorText: string;
  attack1: string;
  hp: string;
  attack3: any;
  attack4: any;
}

interface FormattedAttributes {
  "Card Number / Rarity": string;
  "Card Type / HP / Stage": string;
  "Attack 1": string;
  "Attack 2": string;
  "Weakness / Resistance / Retreat Cost": string;
  Artist: string;
}

export interface Sku {
  sku: number;
  condition: Condition;
  variant: Variant;
  language: Language;
}

export type GetProductDetailsRequestParams = {
  id: number;
};

export async function getProductDetails({
  id,
}: GetProductDetailsRequestParams): Promise<Result> {
  return get<Result>(
    `https://mp-search-api.tcgplayer.com/v2/product/${id}/details`
  );
}
