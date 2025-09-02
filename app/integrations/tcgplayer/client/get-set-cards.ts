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
import { get } from "../../../core/httpClient";
export async function getSetCards({
  setId,
  rows = 5000,
}: GetSetCardsRequestParams): Promise<GetSetCardsResponse> {
  const url = `https://infinite-api.tcgplayer.com/priceguide/set/${setId}/cards/?rows=${rows}`;
  return get<GetSetCardsResponse>(url);
}
