import { data } from "react-router";
import {
  categorySetsRepository as defaultCategorySetsRepository,
  pricingConfigRepository as defaultPricingConfigRepository,
  productsRepository as defaultProductsRepository,
  setProductsRepository as defaultSetProductsRepository,
} from "~/core/db";
import { getConditionSortRank } from "~/core/utils/conditionOrder";
import { createDisplayName } from "~/core/utils/displayNameUtils";
import type { PricingResult } from "~/features/pricing/services/pricingCalculator";
import { PricingCalculator } from "~/features/pricing/services/pricingCalculator";
import { PricingBatchApiCache } from "~/features/pricing/services/pricingBatchApiCache.server";
import { resolveSuggestedPrice } from "~/features/pricing/services/suggestedPriceResolver.server";
import type { Product } from "~/features/inventory-management/types/product";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { Variant } from "~/integrations/tcgplayer/types/Variant";
import {
  getPricePoints as defaultGetPricePoints,
  type GetPricePointsRequestBody,
  type PricePoint,
} from "~/integrations/tcgplayer/client/get-price-points.server";
import type { Sku } from "~/shared/data-types/sku";
import type { CategorySet } from "~/shared/data-types/categorySet";
import type { SetProduct } from "~/shared/data-types/setProduct";
import type {
  ProductPriceMatrixCell,
  ProductPriceMatrixProduct,
  ProductPriceMatrixProductsResponse,
  ProductPriceMatrixRequest,
  ProductPriceMatrixResponse,
  ProductPriceMatrixSearchScope,
} from "../types/productPriceMatrix";

const DISPLAY_VARIANT_ORDER: Variant[] = [
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "Unlimited",
  "Unlimited Holofoil",
  "1st Edition",
  "1st Edition Holofoil",
];

type ProductsRepository = Pick<
  typeof defaultProductsRepository,
  "findBySetId" | "findByIds" | "findByProductId"
>;

type SetProductsRepository = Pick<
  typeof defaultSetProductsRepository,
  "findBySetNameId" | "findByCardNumber" | "findByProductId"
>;

type CategorySetsRepository = Pick<
  typeof defaultCategorySetsRepository,
  "findByCategoryIdAndSetNameId" | "findByCategoryIdAndSetNameIds"
>;

type PricingConfigRepository = Pick<typeof defaultPricingConfigRepository, "get">;

type PricePointsClient = (
  requestBody: GetPricePointsRequestBody,
) => Promise<PricePoint[]>;

type PricingCalculatorFactory = () => Pick<PricingCalculator, "calculatePrices">;

interface ProductPriceMatrixDependencies {
  productsRepository?: ProductsRepository;
  setProductsRepository?: SetProductsRepository;
  categorySetsRepository?: CategorySetsRepository;
  pricingConfigRepository?: PricingConfigRepository;
  getPricePoints?: PricePointsClient;
  createPricingCalculator?: PricingCalculatorFactory;
}

function getDependencies(dependencies: ProductPriceMatrixDependencies = {}) {
  return {
    productsRepository: dependencies.productsRepository ?? defaultProductsRepository,
    setProductsRepository:
      dependencies.setProductsRepository ?? defaultSetProductsRepository,
    categorySetsRepository:
      dependencies.categorySetsRepository ?? defaultCategorySetsRepository,
    pricingConfigRepository:
      dependencies.pricingConfigRepository ?? defaultPricingConfigRepository,
    getPricePoints: dependencies.getPricePoints ?? defaultGetPricePoints,
    createPricingCalculator:
      dependencies.createPricingCalculator ?? (() => new PricingCalculator()),
  };
}

function toPositiveInteger(value: unknown): number | null {
  const numberValue =
    typeof value === "string" || typeof value === "number"
      ? Number(value)
      : Number.NaN;

  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getVariantSortRank(variant: Variant): number {
  const rank = DISPLAY_VARIANT_ORDER.indexOf(variant);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function sortConditions(conditions: Condition[]): Condition[] {
  return [...conditions].sort(
    (left, right) => getConditionSortRank(left) - getConditionSortRank(right),
  );
}

function sortVariants(variants: Variant[]): Variant[] {
  return [...variants].sort((left, right) => {
    const rankDifference = getVariantSortRank(left) - getVariantSortRank(right);
    return rankDifference !== 0 ? rankDifference : left.localeCompare(right);
  });
}

function sortLanguages(languages: string[]): string[] {
  return [...languages].sort((left, right) => {
    if (left === "English") {
      return -1;
    }

    if (right === "English") {
      return 1;
    }

    return left.localeCompare(right);
  });
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function expandProductSkus(product: Product): Sku[] {
  return product.skus.map((sku) => ({
    sku: sku.sku,
    condition: sku.condition,
    variant: sku.variant,
    language: sku.language,
    productTypeName: product.productTypeName,
    rarityName: product.rarityName,
    sealed: product.sealed,
    productName: product.productName,
    setId: product.setId,
    setCode: product.setCode,
    productId: product.productId,
    setName: product.setName,
    productLineId: product.productLineId,
    productStatusId: product.productStatusId,
    productLineName: product.productLineName,
  }));
}

function buildProductSummary(
  product: Product,
  setProduct?: SetProduct | null,
  categorySet?: CategorySet | null,
): ProductPriceMatrixProduct {
  const skus = expandProductSkus(product);

  return {
    productId: product.productId,
    productLineId: product.productLineId,
    productLineName: product.productLineName,
    productName: product.productName,
    displayName: createDisplayName(
      product.productName,
      setProduct?.number ?? null,
      product.rarityName,
    ),
    productTypeName: product.productTypeName,
    rarityName: product.rarityName,
    sealed: product.sealed,
    setId: product.setId,
    setCode: product.setCode,
    setName: product.setName,
    setReleaseDate: categorySet?.releaseDate,
    cardNumber: setProduct?.number ?? null,
    skuCount: skus.length,
    conditions: sortConditions(uniqueValues(skus.map((sku) => sku.condition))),
    variants: sortVariants(uniqueValues(skus.map((sku) => sku.variant))),
    languages: sortLanguages(uniqueValues(skus.map((sku) => sku.language))),
  };
}

function matchesProductQuery(
  product: ProductPriceMatrixProduct,
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return true;
  }

  return [
    product.productName,
    product.displayName,
    product.cardNumber ?? "",
    product.rarityName,
    product.productTypeName,
    product.setName,
    product.setCode,
  ].some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function createPricePointMap(pricePoints: PricePoint[]): Map<number, PricePoint> {
  return new Map(pricePoints.map((pricePoint) => [pricePoint.skuId, pricePoint]));
}

function createPricingResultMap(
  pricingResults: PricingResult[],
): Map<number, PricingResult> {
  return new Map(pricingResults.map((pricingResult) => [pricingResult.sku, pricingResult]));
}

function buildDisplayMap(
  skus: Sku[],
  setProduct?: SetProduct | null,
): Map<number, { sku: number; productName: string }> {
  return new Map(
    skus.map((sku) => [
      sku.sku,
      {
        sku: sku.sku,
        productName: createDisplayName(
          sku.productName,
          setProduct?.number ?? null,
          sku.rarityName,
          sku.variant,
          sku.language,
        ),
      },
    ]),
  );
}

function buildMatrixCell(
  sku: Sku,
  pricePoint: PricePoint | undefined,
  pricingResult: PricingResult | undefined,
): ProductPriceMatrixCell {
  return {
    sku: sku.sku,
    condition: sku.condition,
    variant: sku.variant,
    language: sku.language,
    tcgMarketPrice: pricePoint?.marketPrice ?? null,
    lowestSalePrice: pricePoint?.lowestPrice ?? null,
    highestSalePrice: pricePoint?.highestPrice ?? null,
    saleCount: pricePoint?.priceCount ?? 0,
    priceCalculatedAt: pricePoint?.calculatedAt,
    suggestedPrice: pricingResult?.suggestedPrice ?? null,
    marketplacePrice: pricingResult?.price ?? null,
    percentileUsed: pricingResult?.percentileUsed,
    historicalSalesVelocityDays: pricingResult?.historicalSalesVelocityDays,
    estimatedTimeToSellDays: pricingResult?.estimatedTimeToSellDays,
    salesCountForHistorical: pricingResult?.salesCountForHistorical,
    listingsCountForEstimated: pricingResult?.listingsCountForEstimated,
    percentiles: pricingResult?.percentiles,
    warnings: pricingResult?.warnings ?? [],
    errors: pricingResult?.errors ?? [],
  };
}

export function createProductPriceMatrixProductsLoader(
  dependencies: ProductPriceMatrixDependencies = {},
) {
  const {
    productsRepository,
    setProductsRepository,
    categorySetsRepository,
  } = getDependencies(dependencies);

  return async function loader({ request }: { request: Request }) {
    try {
      const url = new URL(request.url);
      const productLineId = toPositiveInteger(
        url.searchParams.get("productLineId"),
      );
      const scope = (url.searchParams.get("scope") === "allSets"
        ? "allSets"
        : "set") satisfies ProductPriceMatrixSearchScope;
      const query = url.searchParams.get("query")?.trim() ?? "";

      if (!productLineId) {
        return data({ error: "productLineId is required" }, { status: 400 });
      }

      if (scope === "allSets") {
        if (!query) {
          return data({ products: [] } satisfies ProductPriceMatrixProductsResponse, {
            status: 200,
          });
        }

        const matchedSetProducts = await setProductsRepository.findByCardNumber(
          productLineId,
          query,
        );
        const products = await productsRepository.findByIds(
          matchedSetProducts.map((setProduct) => setProduct.productId),
          productLineId,
        );
        const categorySets =
          await categorySetsRepository.findByCategoryIdAndSetNameIds(
            productLineId,
            uniqueValues(matchedSetProducts.map((setProduct) => setProduct.setNameId)),
          );
        const productsById = new Map(
          products.map((product) => [product.productId, product]),
        );
        const categorySetsById = new Map(
          categorySets.map((categorySet) => [categorySet.setNameId, categorySet]),
        );

        const searchResults = matchedSetProducts
          .map((setProduct) => {
            const product = productsById.get(setProduct.productId);
            return product
              ? buildProductSummary(
                  product,
                  setProduct,
                  categorySetsById.get(setProduct.setNameId),
                )
              : null;
          })
          .filter((product): product is ProductPriceMatrixProduct => product !== null)
          .slice(0, 250);

        return data(
          { products: searchResults } satisfies ProductPriceMatrixProductsResponse,
          { status: 200 },
        );
      }

      const setId = toPositiveInteger(url.searchParams.get("setId"));

      if (!setId) {
        return data({ error: "setId is required for set search" }, { status: 400 });
      }

      const [products, setProducts, categorySet] = await Promise.all([
        productsRepository.findBySetId(setId, productLineId),
        setProductsRepository.findBySetNameId(setId),
        categorySetsRepository.findByCategoryIdAndSetNameId(productLineId, setId),
      ]);
      const setProductsByProductId = new Map(
        setProducts.map((setProduct) => [setProduct.productId, setProduct]),
      );
      const searchResults = products
        .map((product) =>
          buildProductSummary(
            product,
            setProductsByProductId.get(product.productId),
            categorySet,
          ),
        )
        .filter((product) => matchesProductQuery(product, query))
        .slice(0, 250);

      return data(
        { products: searchResults } satisfies ProductPriceMatrixProductsResponse,
        { status: 200 },
      );
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}

export function createProductPriceMatrixAction(
  dependencies: ProductPriceMatrixDependencies = {},
) {
  const {
    productsRepository,
    setProductsRepository,
    categorySetsRepository,
    pricingConfigRepository,
    getPricePoints,
    createPricingCalculator,
  } = getDependencies(dependencies);

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as Partial<ProductPriceMatrixRequest>;
      const productId = toPositiveInteger(payload.productId);
      const productLineId = toPositiveInteger(payload.productLineId);
      const selectedLanguage =
        typeof payload.language === "string" && payload.language.trim().length > 0
          ? payload.language.trim()
          : undefined;

      if (!productId) {
        return data({ error: "productId is required" }, { status: 400 });
      }

      if (!productLineId) {
        return data({ error: "productLineId is required" }, { status: 400 });
      }

      const product = await productsRepository.findByProductId(
        productId,
        productLineId,
      );

      if (!product) {
        return data({ error: `Product ${productId} not found` }, { status: 404 });
      }

      const [setProduct, categorySet] = await Promise.all([
        setProductsRepository.findByProductId(product.productId),
        categorySetsRepository.findByCategoryIdAndSetNameId(
          product.productLineId,
          product.setId,
        ),
      ]);
      const allSkus = expandProductSkus(product);
      const availableLanguages = sortLanguages(
        uniqueValues(allSkus.map((sku) => sku.language)),
      );
      const matrixSkus = selectedLanguage
        ? allSkus.filter((sku) => sku.language === selectedLanguage)
        : allSkus;
      const pricePoints =
        matrixSkus.length > 0
          ? await getPricePoints({ skuIds: matrixSkus.map((sku) => sku.sku) })
          : [];
      const pricePointMap = createPricePointMap(pricePoints);
      let pricingResultsBySku = new Map<number, PricingResult>();

      if (payload.includeSuggestedPrices === true && matrixSkus.length > 0) {
        const config = await pricingConfigRepository.get();
        const batchApiCache = new PricingBatchApiCache();
        const pricingCalculator = createPricingCalculator();
        const pricingResult = await pricingCalculator.calculatePrices(
          matrixSkus.map((sku) => ({
            sku: sku.sku,
            quantity: 1,
            productLineId: sku.productLineId,
            setId: sku.setId,
            productId: sku.productId,
            bypassProductLineSkips: true,
          })),
          {
            percentile: config.productLinePricing.defaultPercentile,
            enableSupplyAnalysis: config.supplyAnalysis.enableSupplyAnalysis,
            supplyAnalysisConfig: {
              maxListingsPerSku: config.supplyAnalysis.maxListingsPerSku,
              includeUnverifiedSellers:
                config.supplyAnalysis.includeUnverifiedSellers,
            },
            productLinePricingConfig: config.productLinePricing,
            suggestedPriceResolver: (input) =>
              resolveSuggestedPrice(input, { batchApiCache }),
          },
          pricePointMap,
          "product-price-matrix",
          buildDisplayMap(matrixSkus, setProduct),
        );
        pricingResultsBySku = createPricingResultMap(pricingResult.pricedItems);
      }

      const cells = matrixSkus
        .map((sku) =>
          buildMatrixCell(
            sku,
            pricePointMap.get(sku.sku),
            pricingResultsBySku.get(sku.sku),
          ),
        )
        .sort((left, right) => {
          const variantDifference =
            getVariantSortRank(left.variant) - getVariantSortRank(right.variant);

          if (variantDifference !== 0) {
            return variantDifference;
          }

          const conditionDifference =
            getConditionSortRank(left.condition) - getConditionSortRank(right.condition);

          if (conditionDifference !== 0) {
            return conditionDifference;
          }

          return left.language.localeCompare(right.language);
        });

      const response: ProductPriceMatrixResponse = {
        product: buildProductSummary(product, setProduct, categorySet),
        selectedLanguage,
        availableLanguages,
        conditions: sortConditions(uniqueValues(cells.map((cell) => cell.condition))),
        variants: sortVariants(uniqueValues(cells.map((cell) => cell.variant))),
        cells,
        suggestedPricesIncluded: payload.includeSuggestedPrices === true,
        pricedAt: new Date().toISOString(),
      };

      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
