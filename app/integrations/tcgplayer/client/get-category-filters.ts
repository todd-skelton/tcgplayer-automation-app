import { get } from "../../../core/httpClient";

export interface CategoryFilterVariant {
  id: number;
  name: string;
  displayOrder: number;
}

export interface CategoryFilterCondition {
  id: number;
  name: string;
  abbreviation: string;
}

export interface CategoryFilterLanguage {
  id: number;
  name: string;
  abbreviation: string;
}

export interface CategoryFiltersResponse {
  variants: CategoryFilterVariant[];
  conditions: CategoryFilterCondition[];
  languages: CategoryFilterLanguage[];
}

export async function getCategoryFilters(
  categoryId: number
): Promise<CategoryFiltersResponse> {
  return get<CategoryFiltersResponse>(
    `https://mp-search-api.tcgplayer.com/v1/product/categoryfilters?categoryId=${categoryId}`
  );
}
