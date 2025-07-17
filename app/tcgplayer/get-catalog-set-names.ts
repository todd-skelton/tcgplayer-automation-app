interface GetCatalogSetNamesResponse {
  errors: any[];
  results: Result[];
}

interface Result {
  setNameId: number;
  categoryId: number;
  name: string;
  cleanSetName: string;
  urlName: string;
  abbreviation?: string;
  releaseDate?: string;
  isSupplemental: boolean;
  active: boolean;
}

export interface GetCatalogSetNamesRequestParams {
  categoryId: number;
}

import { get } from "~/httpClient";
export async function getCatalogSetNames({
  categoryId,
}: GetCatalogSetNamesRequestParams): Promise<GetCatalogSetNamesResponse> {
  const url = `https://mpapi.tcgplayer.com/v2/Catalog/SetNames?categoryId=${categoryId}`;
  return get<GetCatalogSetNamesResponse>(url);
}
