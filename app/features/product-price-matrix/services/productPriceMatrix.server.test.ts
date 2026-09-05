import assert from "node:assert/strict";
import {
  createProductPriceMatrixAction,
  createProductPriceMatrixProductsLoader,
} from "./productPriceMatrix.server";
import type { Product } from "~/features/inventory-management/types/product";
import type { ContinuousPricingInventoryItem } from "~/features/continuous-pricing/types/continuousPricing";
import type { InventoryPublicationConfiguration } from "~/features/inventory-publication/types/inventoryPublicationSettings";
import { DEFAULT_INVENTORY_PUBLICATION_SETTINGS } from "~/features/inventory-publication/types/inventoryPublicationSettings";
import type { PricingConfig } from "~/core/types/pricing";
import type { PricingCalculationResult } from "~/features/pricing/services/pricingCalculator";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import type { SetProduct } from "~/shared/data-types/setProduct";
import type { CategorySet } from "~/shared/data-types/categorySet";
import type {
  ProductPriceMatrixProductsResponse,
  ProductPriceMatrixResponse,
} from "../types/productPriceMatrix";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

async function parseRouteResult<T>(result: {
  data: unknown;
  init?: ResponseInit | null;
}) {
  return {
    status: result.init?.status ?? 200,
    body: result.data as T,
  };
}

const product: Product = {
  productTypeName: "Cards",
  rarityName: "Rare Holo",
  sealed: false,
  productName: "Pikachu",
  setId: 10,
  setCode: "SV1",
  productId: 100,
  setName: "Scarlet & Violet",
  productLineId: 3,
  productStatusId: 1,
  productLineName: "Pokemon",
  skus: [
    {
      sku: 1001,
      condition: "Lightly Played",
      variant: "Normal",
      language: "English",
    },
    {
      sku: 1002,
      condition: "Near Mint",
      variant: "Normal",
      language: "English",
    },
    {
      sku: 1003,
      condition: "Near Mint",
      variant: "Holofoil",
      language: "English",
    },
  ],
};

const setProduct: SetProduct = {
  setNameId: 10,
  productId: 100,
  game: "Pokemon",
  number: "025/198",
  productName: "Pikachu",
  rarity: "Rare Holo",
  set: "Scarlet & Violet",
  setAbbrv: "SV1",
  type: "Cards",
  displayName: "Pikachu - 025/198",
};

const categorySet: CategorySet = {
  setNameId: 10,
  categoryId: 3,
  name: "Scarlet & Violet",
  cleanSetName: "Scarlet & Violet",
  urlName: "scarlet-violet",
  abbreviation: "SV1",
  releaseDate: "2023-03-31",
  isSupplemental: false,
  active: true,
};

function createListing(
  sku: number,
  currentPrice: number | null,
  quantity: number,
): ContinuousPricingInventoryItem {
  const now = new Date("2026-06-09T12:00:00.000Z");
  return {
    sellerKey: "store",
    sku,
    productId: 100,
    productLineId: 3,
    setId: 10,
    productLine: "Pokemon",
    setName: "Scarlet & Violet",
    productName: "Pikachu",
    condition: "Near Mint",
    variant: "Normal",
    quantity,
    currentPrice,
    marketPrice: null,
    inStock: quantity > 0,
    pricingEligible: true,
    enabled: true,
    pauseReason: null,
    lastObservedAt: now,
    lastPricedAt: null,
    lastPublishedPrice: null,
    lastPublishedAt: null,
    nextPriceAt: now,
    lastBatchNumber: null,
    consecutivePricingFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createPublicationConfiguration(
  sellerKey: string,
): InventoryPublicationConfiguration {
  return {
    settings: {
      ...DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
      continuousPricing: {
        ...DEFAULT_INVENTORY_PUBLICATION_SETTINGS.continuousPricing,
        sellerKey,
      },
    },
    runtime: {
      authenticationStatus: "unknown",
      circuitOpen: false,
      consecutiveFailures: 0,
      pauseReason: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      runtimeUpdatedAt: new Date("2026-06-09T12:00:00.000Z"),
    },
    updatedAt: new Date("2026-06-09T12:00:00.000Z"),
  };
}

/** A calculator that records its config and prices each SKU at a fixed price. */
function createFakeCalculator(pricesBySku: Record<number, number>) {
  const calls: PricingConfig[] = [];
  const pricedSkus: { sku: number; currentPrice?: number }[][] = [];
  return {
    calls,
    pricedSkus,
    factory: () => ({
      calculatePrices: async (
        skus: { sku: number; currentPrice?: number }[],
        config: PricingConfig,
      ): Promise<PricingCalculationResult> => {
        calls.push(config);
        pricedSkus.push(skus);
        return {
          pricedItems: skus.map(({ sku }) => ({
            sku,
            suggestedPrice: pricesBySku[sku],
            price: pricesBySku[sku],
            estimatedTimeToSellDays: 7,
            warnings: [],
            errors: [],
            pricingDecision: {
              method: "profit-per-day",
              selectedPrice: pricesBySku[sku],
              unconstrainedPrice: pricesBySku[sku],
              dailyReturnHurdle: 0.005,
              equivalentPercentile: 50,
              constraint: "none",
              basis: "modeled",
              forecastStatus: "interpolated",
            },
            shadowPricingDecision: {
              method: "percentile",
              selectedPrice: pricesBySku[sku] + 1,
              configuredPercentile: 65,
              constraint: "none",
              basis: "modeled",
              forecastStatus: "interpolated",
            },
          })),
          stats: {
            processed: skus.length,
            skipped: 0,
            errors: 0,
            warnings: 0,
            processingTime: 1,
          },
          aggregatedPercentiles: {
            marketPrice: {},
            historicalSalesVelocity: {},
            estimatedTimeToSell: {},
          },
        };
      },
    }),
  };
}

function createDependencies(sellerKey = "store") {
  return {
    pricingConfigRepository: {
      get: async () => ({
        ...DEFAULT_SERVER_PRICING_CONFIG,
        pricing: {
          ...DEFAULT_SERVER_PRICING_CONFIG.pricing,
          policy: { method: "profit-per-day" as const },
          minPriceMultiplier: 0.9,
          minPriceConstant: 0.05,
        },
        productLinePricing: {
          ...DEFAULT_SERVER_PRICING_CONFIG.productLinePricing,
          productLineSettings: {
            3: { percentile: 65, skip: false, dailyReturnHurdle: 0.01 },
          },
        },
        updatedAt: new Date("2026-06-09T12:00:00.000Z"),
      }),
    },
    inventoryPublicationSettingsRepository: {
      get: async () => createPublicationConfiguration(sellerKey),
    },
    continuousPricingRepository: {
      findBySkus: async (requestedSellerKey: string, skus: number[]) => {
        assert.equal(requestedSellerKey, "store");
        return [createListing(1002, 2.75, 3), createListing(1001, 1.5, 0)].filter(
          (listing) => skus.includes(listing.sku),
        );
      },
    },
    productsRepository: {
      findBySetId: async () => [product],
      findByIds: async () => [product],
      findByProductId: async () => product,
    },
    setProductsRepository: {
      findBySetNameId: async () => [setProduct],
      findByCardNumber: async () => [setProduct],
      findByProductId: async () => setProduct,
    },
    categorySetsRepository: {
      findByCategoryIdAndSetNameId: async () => categorySet,
      findByCategoryIdAndSetNameIds: async () => [categorySet],
    },
    getPricePoints: async () => [
      {
        skuId: 1001,
        marketPrice: 1.25,
        lowestPrice: 1,
        highestPrice: 2,
        priceCount: 12,
        calculatedAt: "2026-06-09T12:00:00.000Z",
      },
      {
        skuId: 1002,
        marketPrice: 2.5,
        lowestPrice: 2,
        highestPrice: 4,
        priceCount: 20,
        calculatedAt: "2026-06-09T12:00:00.000Z",
      },
      {
        skuId: 1003,
        marketPrice: 3.75,
        lowestPrice: 3,
        highestPrice: 6,
        priceCount: 8,
        calculatedAt: "2026-06-09T12:00:00.000Z",
      },
    ],
  };
}

const testCases: TestCase[] = [
  {
    name: "product matrix search returns product summaries for a selected set",
    run: async () => {
      const loader = createProductPriceMatrixProductsLoader(createDependencies());

      const result = await loader({
        request: new Request(
          "http://localhost/api/product-price-matrix/products?productLineId=3&scope=set&setId=10&query=pika",
        ),
      });
      const parsed = await parseRouteResult<ProductPriceMatrixProductsResponse>(
        result,
      );

      assert.equal(parsed.status, 200);
      assert.equal(parsed.body.products.length, 1);
      assert.deepEqual(parsed.body.products[0], {
        productId: 100,
        productLineId: 3,
        productLineName: "Pokemon",
        productName: "Pikachu",
        displayName: "Pikachu - 025/198 - Rare Holo",
        productTypeName: "Cards",
        rarityName: "Rare Holo",
        sealed: false,
        setId: 10,
        setCode: "SV1",
        setName: "Scarlet & Violet",
        setReleaseDate: "2023-03-31",
        cardNumber: "025/198",
        skuCount: 3,
        conditions: ["Near Mint", "Lightly Played"],
        variants: ["Normal", "Holofoil"],
        languages: ["English"],
      });
    },
  },
  {
    name: "product matrix action returns market prices by condition and variant",
    run: async () => {
      const action = createProductPriceMatrixAction(createDependencies());

      const result = await action({
        request: new Request("http://localhost/api/product-price-matrix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: 100,
            productLineId: 3,
            language: "English",
            includeSuggestedPrices: false,
          }),
        }),
      });
      const parsed = await parseRouteResult<ProductPriceMatrixResponse>(result);

      assert.equal(parsed.status, 200);
      assert.equal(parsed.body.product.productId, 100);
      assert.equal(parsed.body.selectedLanguage, "English");
      assert.equal(parsed.body.suggestedPricesIncluded, false);
      assert.deepEqual(parsed.body.conditions, ["Near Mint", "Lightly Played"]);
      assert.deepEqual(parsed.body.variants, ["Normal", "Holofoil"]);
      assert.equal(parsed.body.cells.length, 3);
      assert.deepEqual(
        parsed.body.cells.map((cell) => ({
          sku: cell.sku,
          condition: cell.condition,
          variant: cell.variant,
          marketPrice: cell.tcgMarketPrice,
          saleCount: cell.saleCount,
          suggestedPrice: cell.suggestedPrice,
        })),
        [
          {
            sku: 1002,
            condition: "Near Mint",
            variant: "Normal",
            marketPrice: 2.5,
            saleCount: 20,
            suggestedPrice: null,
          },
          {
            sku: 1001,
            condition: "Lightly Played",
            variant: "Normal",
            marketPrice: 1.25,
            saleCount: 12,
            suggestedPrice: null,
          },
          {
            sku: 1003,
            condition: "Near Mint",
            variant: "Holofoil",
            marketPrice: 3.75,
            saleCount: 8,
            suggestedPrice: null,
          },
        ],
      );
    },
  },
  {
    name: "product matrix action prices conditions under the active policy beside the store's listings",
    run: async () => {
      const calculator = createFakeCalculator({ 1002: 3, 1001: 3.4, 1003: 5 });
      const action = createProductPriceMatrixAction({
        ...createDependencies(),
        createPricingCalculator: calculator.factory,
      });

      const result = await action({
        request: new Request("http://localhost/api/product-price-matrix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: 100,
            productLineId: 3,
            language: "English",
            includeSuggestedPrices: true,
          }),
        }),
      });
      const parsed = await parseRouteResult<ProductPriceMatrixResponse>(result);

      assert.equal(parsed.status, 200);
      assert.equal(calculator.calls.length, 1);
      const config = calculator.calls[0];
      assert.deepEqual(config.policy, {
        method: "profit-per-day",
        dailyReturnHurdle: 0.005,
        relativeOverhead: 0.15,
        staticOverheadPerUnit: 0.3,
      });
      assert.equal(config.minPriceMultiplier, 0.9);
      assert.equal(config.minPriceConstant, 0.05);
      assert.equal(config.supplyAnalysisConfig?.excludedSellerKey, "store");
      assert.deepEqual(config.productLinePricingConfig?.productLineSettings[3], {
        percentile: 65,
        skip: false,
        dailyReturnHurdle: 0.01,
      });
      // The header names the policy as it applies to this product line.
      assert.deepEqual(parsed.body.policy, {
        ...config.policy,
        dailyReturnHurdle: 0.01,
      });
      // Only the in-stock listing is handed to the calculator as the current price.
      assert.deepEqual(
        calculator.pricedSkus[0].map(({ sku, currentPrice }) => [sku, currentPrice]),
        [
          [1001, undefined],
          [1002, 2.75],
          [1003, undefined],
        ],
      );
      assert.equal(parsed.body.suggestedPricesIncluded, true);
      assert.equal(parsed.body.listingsIncluded, true);
      assert.deepEqual(
        parsed.body.cells.map((cell) => ({
          sku: cell.sku,
          sellAtPrice: cell.sellAtPrice,
          ladderPrice: cell.ladderPrice,
          marketLadderPrice: cell.marketLadderPrice,
          aboveBetterCondition: cell.aboveBetterCondition,
          listing: cell.listing,
          shadowPrice: cell.shadowPricingDecision?.selectedPrice,
          rule: cell.pricingDecision?.method,
        })),
        [
          {
            sku: 1002,
            sellAtPrice: 3,
            ladderPrice: 3,
            marketLadderPrice: 2.5,
            aboveBetterCondition: false,
            listing: { price: 2.75, quantity: 3, inStock: true },
            shadowPrice: 4,
            rule: "profit-per-day",
          },
          {
            sku: 1001,
            sellAtPrice: 3.4,
            ladderPrice: 3,
            marketLadderPrice: 1.25,
            aboveBetterCondition: true,
            listing: { price: 1.5, quantity: 0, inStock: false },
            shadowPrice: 4.4,
            rule: "profit-per-day",
          },
          {
            sku: 1003,
            sellAtPrice: 5,
            ladderPrice: 5,
            marketLadderPrice: 3.75,
            aboveBetterCondition: false,
            listing: null,
            shadowPrice: 6,
            rule: "profit-per-day",
          },
        ],
      );
    },
  },
  {
    name: "product matrix action leaves listings out without a continuous pricing seller key",
    run: async () => {
      const calculator = createFakeCalculator({ 1002: 3, 1001: 2, 1003: 5 });
      const action = createProductPriceMatrixAction({
        ...createDependencies(""),
        continuousPricingRepository: {
          findBySkus: async () => {
            throw new Error("Listings must not be looked up without a seller key");
          },
        },
        createPricingCalculator: calculator.factory,
      });

      const result = await action({
        request: new Request("http://localhost/api/product-price-matrix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: 100,
            productLineId: 3,
            language: "English",
            includeSuggestedPrices: true,
          }),
        }),
      });
      const parsed = await parseRouteResult<ProductPriceMatrixResponse>(result);

      assert.equal(parsed.status, 200);
      assert.equal(parsed.body.listingsIncluded, false);
      assert.equal(calculator.calls[0].supplyAnalysisConfig?.excludedSellerKey, undefined);
      assert.deepEqual(
        parsed.body.cells.map((cell) => cell.listing),
        [null, null, null],
      );
    },
  },
  {
    name: "product matrix action still answers when the store's listings cannot be read",
    run: async () => {
      const calculator = createFakeCalculator({ 1002: 3, 1001: 2, 1003: 5 });
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (message: string) => {
        warnings.push(message);
      };
      try {
        const action = createProductPriceMatrixAction({
          ...createDependencies(),
          inventoryPublicationSettingsRepository: {
            get: async () => {
              throw new Error("settings unavailable");
            },
          },
          createPricingCalculator: calculator.factory,
        });

        const result = await action({
          request: new Request("http://localhost/api/product-price-matrix", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              productId: 100,
              productLineId: 3,
              language: "English",
              includeSuggestedPrices: true,
            }),
          }),
        });
        const parsed = await parseRouteResult<ProductPriceMatrixResponse>(result);

        assert.equal(parsed.status, 200);
        assert.equal(parsed.body.listingsIncluded, false);
        assert.equal(parsed.body.cells[0].sellAtPrice, 3);
        assert.equal(
          calculator.calls[0].supplyAnalysisConfig?.excludedSellerKey,
          undefined,
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /settings unavailable/);
      } finally {
        console.warn = originalWarn;
      }
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} product price matrix tests.`);
}
