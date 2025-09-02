import { get } from "../../../core/httpClient";

export interface ProductLine {
  productLineId: number;
  productLineName: string;
  productLineUrlName: string;
  isDirect: boolean;
}

export async function getProductLines(): Promise<ProductLine[]> {
  return get<ProductLine[]>(
    "https://mp-search-api.tcgplayer.com/v1/search/productLines"
  );
}
