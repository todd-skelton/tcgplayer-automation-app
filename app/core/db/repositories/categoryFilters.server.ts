import type { CategoryFilter } from "~/shared/data-types/categoryFilter";
import { asJson, execute, queryOne, type Queryable } from "../database.server";

type CategoryFilterRow = CategoryFilter;

export const categoryFiltersRepository = {
  async findByCategoryId(
    categoryId: number,
    executor?: Queryable,
  ): Promise<CategoryFilter | null> {
    return queryOne<CategoryFilterRow>(
      `SELECT
        category_id AS "categoryId",
        variants,
        conditions,
        languages
      FROM category_filters
      WHERE category_id = $1`,
      [categoryId],
      executor,
    );
  },

  async upsert(
    categoryFilter: CategoryFilter,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO category_filters (
        category_id,
        variants,
        conditions,
        languages
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
      ON CONFLICT (category_id) DO UPDATE SET
        variants = EXCLUDED.variants,
        conditions = EXCLUDED.conditions,
        languages = EXCLUDED.languages`,
      [
        categoryFilter.categoryId,
        asJson(categoryFilter.variants),
        asJson(categoryFilter.conditions),
        asJson(categoryFilter.languages),
      ],
      executor,
    );
  },
};
