// CategoryFilter type for storing category filters in the database
import type { CategoryFilterVariant } from "../../integrations/tcgplayer/client/get-category-filters.server";
import type { CategoryFilterCondition } from "../../integrations/tcgplayer/client/get-category-filters.server";
import type { CategoryFilterLanguage } from "../../integrations/tcgplayer/client/get-category-filters.server";

export interface CategoryFilter {
  categoryId: number;
  variants: CategoryFilterVariant[];
  conditions: CategoryFilterCondition[];
  languages: CategoryFilterLanguage[];
}
