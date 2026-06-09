import assert from "node:assert/strict";
import {
  createProductPriceMatrixAction,
  createProductPriceMatrixProductsLoader,
} from "./productPriceMatrix.server";
import type { Product } from "~/features/inventory-management/types/product";
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

function createDependencies() {
  return {
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
