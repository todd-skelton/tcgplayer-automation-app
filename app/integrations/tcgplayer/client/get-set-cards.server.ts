interface GetSetCardsResponse {
  count: number;
  total: number;
  result: Result[];
}

interface Result {
  productID: number;
  productConditionID: number;
  condition: string;
  game: string;
  isSupplemental: boolean;
  lowPrice: number;
  marketPrice: number;
  number: string;
  printing: string;
  productName: string;
  rarity: string;
  sales: number;
  set: string;
  setAbbrv: string;
  type: string;
}

export type GetSetCardsRequestParams = {
  setId: number;
  rows?: number;
};

import { infiniteApi } from "../../../core/clients";

export async function getSetCards({
  setId,
  rows = 5000,
}: GetSetCardsRequestParams): Promise<GetSetCardsResponse> {
  return infiniteApi.get<GetSetCardsResponse>(
    `/priceguide/set/${setId}/cards/?rows=${rows}`,
  );
}
