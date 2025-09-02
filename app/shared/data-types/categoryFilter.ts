// CategoryFilter type for storing category filters in the database
import type { CategoryFilterVariant } from "../../integrations/tcgplayer/client/get-category-filters";
import type { CategoryFilterCondition } from "../../integrations/tcgplayer/client/get-category-filters";
import type { CategoryFilterLanguage } from "../../integrations/tcgplayer/client/get-category-filters";

export interface CategoryFilter {
  categoryId: number;
  variants: CategoryFilterVariant[];
  conditions: CategoryFilterCondition[];
  languages: CategoryFilterLanguage[];
}
