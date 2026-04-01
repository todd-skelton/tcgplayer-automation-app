import type { CategorySet } from "~/shared/data-types/categorySet";
import {
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type CategorySetRow = CategorySet;

export const categorySetsRepository = {
  async findByCategoryId(
    categoryId: number,
    executor?: Queryable,
  ): Promise<CategorySet[]> {
    return query<CategorySetRow>(
      `SELECT
        set_name_id AS "setNameId",
        category_id AS "categoryId",
        name,
        clean_set_name AS "cleanSetName",
        url_name AS "urlName",
        abbreviation,
        release_date AS "releaseDate",
        is_supplemental AS "isSupplemental",
        active
      FROM category_sets
      WHERE category_id = $1
      ORDER BY name ASC`,
      [categoryId],
      executor,
    );
  },

  async findByCategoryIdAndSetNameId(
    categoryId: number,
    setNameId: number,
    executor?: Queryable,
  ): Promise<CategorySet | null> {
    return queryOne<CategorySetRow>(
      `SELECT
        set_name_id AS "setNameId",
        category_id AS "categoryId",
        name,
        clean_set_name AS "cleanSetName",
        url_name AS "urlName",
        abbreviation,
        release_date AS "releaseDate",
        is_supplemental AS "isSupplemental",
        active
      FROM category_sets
      WHERE category_id = $1 AND set_name_id = $2`,
      [categoryId, setNameId],
      executor,
    );
  },

  async findByCategoryIdAndSetNameIds(
    categoryId: number,
    setNameIds: number[],
    executor?: Queryable,
  ): Promise<CategorySet[]> {
    if (setNameIds.length === 0) {
      return [];
    }

    return query<CategorySetRow>(
      `SELECT
        set_name_id AS "setNameId",
        category_id AS "categoryId",
        name,
        clean_set_name AS "cleanSetName",
        url_name AS "urlName",
        abbreviation,
        release_date AS "releaseDate",
        is_supplemental AS "isSupplemental",
        active
      FROM category_sets
      WHERE category_id = $1
        AND set_name_id = ANY($2::int[])`,
      [categoryId, setNameIds],
      executor,
    );
  },

  async findByCategoryIdAndUrlName(
    categoryId: number,
    urlName: string,
    executor?: Queryable,
  ): Promise<CategorySet | null> {
    return queryOne<CategorySetRow>(
      `SELECT
        set_name_id AS "setNameId",
        category_id AS "categoryId",
        name,
        clean_set_name AS "cleanSetName",
        url_name AS "urlName",
        abbreviation,
        release_date AS "releaseDate",
        is_supplemental AS "isSupplemental",
        active
      FROM category_sets
      WHERE category_id = $1 AND url_name = $2`,
      [categoryId, urlName],
      executor,
    );
  },

  async upsert(categorySet: CategorySet, executor?: Queryable): Promise<void> {
    await execute(
      `INSERT INTO category_sets (
        set_name_id,
        category_id,
        name,
        clean_set_name,
        url_name,
        abbreviation,
        release_date,
        is_supplemental,
        active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (set_name_id) DO UPDATE SET
        category_id = EXCLUDED.category_id,
        name = EXCLUDED.name,
        clean_set_name = EXCLUDED.clean_set_name,
        url_name = EXCLUDED.url_name,
        abbreviation = EXCLUDED.abbreviation,
        release_date = EXCLUDED.release_date,
        is_supplemental = EXCLUDED.is_supplemental,
        active = EXCLUDED.active`,
      [
        categorySet.setNameId,
        categorySet.categoryId,
        categorySet.name,
        categorySet.cleanSetName,
        categorySet.urlName,
        categorySet.abbreviation ?? null,
        categorySet.releaseDate ?? null,
        categorySet.isSupplemental,
        categorySet.active,
      ],
      executor,
    );
  },

  async upsertMany(categorySets: CategorySet[]): Promise<void> {
    if (categorySets.length === 0) {
      return;
    }

    await withTransaction(async (client) => {
      const chunkSize = 250;

      for (let index = 0; index < categorySets.length; index += chunkSize) {
        const chunk = categorySets.slice(index, index + chunkSize);
        const values = chunk.flatMap((categorySet) => [
          categorySet.setNameId,
          categorySet.categoryId,
          categorySet.name,
          categorySet.cleanSetName,
          categorySet.urlName,
          categorySet.abbreviation ?? null,
          categorySet.releaseDate ?? null,
          categorySet.isSupplemental,
          categorySet.active,
        ]);

        await client.query(
          `INSERT INTO category_sets (
            set_name_id,
            category_id,
            name,
            clean_set_name,
            url_name,
            abbreviation,
            release_date,
            is_supplemental,
            active
          ) VALUES ${createValuesPlaceholders(chunk.length, 9)}
          ON CONFLICT (set_name_id) DO UPDATE SET
            category_id = EXCLUDED.category_id,
            name = EXCLUDED.name,
            clean_set_name = EXCLUDED.clean_set_name,
            url_name = EXCLUDED.url_name,
            abbreviation = EXCLUDED.abbreviation,
            release_date = EXCLUDED.release_date,
            is_supplemental = EXCLUDED.is_supplemental,
            active = EXCLUDED.active`,
          values,
        );
      }
    });
  },
};
