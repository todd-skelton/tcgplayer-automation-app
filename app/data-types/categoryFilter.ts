// CategoryFilter type for storing category filters in the database
import type { CategoryFilterVariant } from "../tcgplayer/get-category-filters";
import type { CategoryFilterCondition } from "../tcgplayer/get-category-filters";
import type { CategoryFilterLanguage } from "../tcgplayer/get-category-filters";

export interface CategoryFilter {
  categoryId: number;
  variants: CategoryFilterVariant[];
  conditions: CategoryFilterCondition[];
  languages: CategoryFilterLanguage[];
}
