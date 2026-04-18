import assert from "node:assert/strict";
import type { Sku } from "~/shared/data-types/sku";
import {
  buildPullSheetItemsFromRows,
  extractPullSheetCsvParts,
  loadPullSheetItemsFromCsvText,
  parsePullSheetCsv,
} from "./pullSheetItems";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const SAMPLE_CSV = [
  "Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity",
  "Pokemon,Charizard ex,Near Mint,H4,Base,Ultra Rare,2,https://example.com,2024-01-01,101,ORD-1",
  "Pokemon,Pikachu,Lightly Played,25,Jungle,Common,1,https://example.com,1999-01-09,202,ORD-2",
].join("\n");

function createSku(overrides: Partial<Sku> = {}): Sku {
  return {
    sku: 101,
    condition: "Near Mint",
    variant: "Holofoil",
    language: "English",
    productTypeName: "Cards",
    rarityName: "Ultra Rare",
    sealed: false,
    productName: "Charizard ex",
    setId: 10,
    setCode: "BASE",
    productId: 999,
    setName: "Base",
    productLineId: 1,
    productStatusId: 1,
    productLineName: "Pokemon",
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "extractPullSheetCsvParts strips the trailing order summary line",
    run: () => {
      const result = extractPullSheetCsvParts(
        `${SAMPLE_CSV}\nOrders Contained in Pull Sheet:, ORD-1 | ORD-2 `,
      );

      assert.equal(result.orderIds.length, 2);
      assert.deepEqual(result.orderIds, ["ORD-1", "ORD-2"]);
      assert.ok(result.csvText.includes("Charizard ex"));
      assert.ok(!result.csvText.includes("Orders Contained in Pull Sheet"));
    },
  },
  {
    name: "parsePullSheetCsv returns valid rows and order ids",
    run: () => {
      const result = parsePullSheetCsv(
        `${SAMPLE_CSV}\nOrders Contained in Pull Sheet:,ORD-1|ORD-2`,
      );

      assert.equal(result.rows.length, 2);
      assert.deepEqual(result.orderIds, ["ORD-1", "ORD-2"]);
      assert.equal(result.rows[0]?.SkuId, "101");
    },
  },
  {
    name: "parsePullSheetCsv rejects csv files with no usable rows",
    run: () => {
      assert.throws(
        () =>
          parsePullSheetCsv(
            "Product Line,Product Name,Condition,SkuId\nPokemon,,,",
          ),
        /No valid rows found in CSV/,
      );
    },
  },
  {
    name: "parsePullSheetCsv repairs malformed quotes in the product name field",
    run: () => {
      const malformedCsv = [
        "Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity",
        '"One Piece Card Game","Eustass"Captain"Kid - EB04-039 (SP)","Near Mint Foil","EB04-039","The Azure Sea\'s Seven","R","1","","01/16/2026 00:00:00","9077713","ORDER-1"',
      ].join("\n");

      const result = parsePullSheetCsv(malformedCsv);

      assert.equal(result.rows.length, 1);
      assert.match(result.csvText, /"Eustass""Captain""Kid - EB04-039 \(SP\)"/);
      assert.equal(
        result.rows[0]?.["Product Name"],
        'Eustass"Captain"Kid - EB04-039 (SP)',
      );
    },
  },
  {
    name: "buildPullSheetItemsFromRows merges lookup data when it exists",
    run: () => {
      const parsed = parsePullSheetCsv(SAMPLE_CSV);
      const items = buildPullSheetItemsFromRows(parsed.rows, {
        101: createSku(),
      });

      assert.equal(items[0]?.productId, 999);
      assert.equal(items[0]?.variant, "Holofoil");
      assert.equal(items[0]?.found, true);
      assert.equal(items[1]?.found, false);
    },
  },
  {
    name: "loadPullSheetItemsFromCsvText tolerates partial enrichment results",
    run: async () => {
      const result = await loadPullSheetItemsFromCsvText(SAMPLE_CSV, async () => ({
        ok: true,
        json: async () => ({
          skuMap: {
            101: createSku(),
          },
        }),
      }));

      assert.equal(result.items.length, 2);
      assert.equal(result.items[0]?.productId, 999);
      assert.equal(result.items[1]?.productId, undefined);
      assert.equal(result.items[1]?.found, false);
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
  console.log(`Passed ${testCases.length} pull sheet item utility tests.`);
}
