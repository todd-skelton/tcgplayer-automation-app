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

import { mpApi } from "../../../core/clients";

export async function getCatalogSetNames({
  categoryId,
}: GetCatalogSetNamesRequestParams): Promise<GetCatalogSetNamesResponse> {
  return mpApi.get<GetCatalogSetNamesResponse>(
    `/v2/Catalog/SetNames?categoryId=${categoryId}`,
  );
}
