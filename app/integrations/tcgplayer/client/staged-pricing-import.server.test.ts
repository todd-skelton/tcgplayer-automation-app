import assert from "node:assert/strict";
import {
  buildFinalizeStagedPricingImportForm,
  buildInitializeStagedPricingImportForm,
  buildMoveStagedPricingImportToLiveForm,
  buildRollbackStagedPricingImportForm,
  buildUploadStagedPricingChunkForm,
  finalizeStagedPricingImport,
  initializeStagedPricingImport,
  moveStagedPricingImportToLive,
  rollbackStagedPricingImport,
  STAGED_PRICING_IMPORT_CHUNK_SIZE,
  type SellerPortalFormPost,
  type StagedPricingUpdate,
  uploadStagedPricingChunk,
} from "./staged-pricing-import.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const update: StagedPricingUpdate = {
  sku: 5199433,
  addToQuantity: -1,
  price: 24.57,
};

function postResponse(response: unknown): SellerPortalFormPost {
  return async <TResponse>(): Promise<TResponse> => response as TResponse;
}

const testCases: TestCase[] = [
  {
    name: "staged pricing forms preserve the verified minimal import contract",
    run: () => {
      assert.equal(
        buildInitializeStagedPricingImportForm(
          "inventory-batch-90.csv",
        ).toString(),
        "filename=inventory-batch-90.csv&type=Pricing",
      );

      const upload = buildUploadStagedPricingChunkForm({
        fileName: "inventory-batch-90.csv",
        uploadId: 16104570,
        updates: [update],
      });
      assert.equal(upload.get("data[0][Id]"), "0");
      assert.equal(upload.get("data[0][ProductConditionId]"), "5199433");
      assert.equal(upload.get("data[0][AddToQuantity]"), "-1");
      assert.equal(upload.get("data[0][MyPrice]"), "24.57");
      assert.equal(upload.get("data[0][CategoryName]"), null);
      assert.equal(upload.get("data[0][SetName]"), null);
      assert.equal(upload.get("data[0][ProductName]"), null);
      assert.equal(upload.get("data[0][ConditionName]"), null);
      assert.equal(
        upload.toString(),
        "data%5B0%5D%5BId%5D=0&data%5B0%5D%5BProductConditionId%5D=5199433&data%5B0%5D%5BAddToQuantity%5D=-1&data%5B0%5D%5BMyPrice%5D=24.57&stagedPricingUploadId=16104570&fileName=inventory-batch-90.csv&type=Pricing",
      );
      assert.equal(upload.get("stagedPricingUploadId"), "16104570");
      assert.equal(upload.get("fileName"), "inventory-batch-90.csv");
      assert.equal(upload.get("type"), "Pricing");

      assert.equal(
        buildFinalizeStagedPricingImportForm({
          uploadId: 16104570,
          successfulProductCount: 1,
        }).toString(),
        "stagedPricingUploadId=16104570&productCount=1&type=Pricing",
      );
      assert.equal(
        buildRollbackStagedPricingImportForm(16104570).toString(),
        "stagedPricingUploadId=16104570&type=Pricing",
      );
      assert.equal(
        buildMoveStagedPricingImportToLiveForm({
          uploadId: 16104570,
        }).toString(),
        "scope=3&connectionId=&stagedPricingUploadId=16104570&type=Pricing",
      );
    },
  },
  {
    name: "staged pricing upload accepts deltas and enforces chunk size",
    run: () => {
      assert.doesNotThrow(() =>
        buildUploadStagedPricingChunkForm({
          fileName: "delta.csv",
          uploadId: 1,
          updates: [
            { ...update, addToQuantity: -2 },
            { ...update, sku: 5199434, addToQuantity: 0 },
            { ...update, sku: 5199435, addToQuantity: 3 },
          ],
        }),
      );
      assert.throws(
        () =>
          buildUploadStagedPricingChunkForm({
            fileName: "too-large.csv",
            uploadId: 1,
            updates: Array.from(
              { length: STAGED_PRICING_IMPORT_CHUNK_SIZE + 1 },
              (_, index) => ({ ...update, sku: update.sku + index }),
            ),
          }),
        /no more than 750 pricing updates/,
      );
    },
  },
  {
    name: "staged pricing operations call Seller Portal endpoints in order",
    run: async () => {
      const calls: Array<{ path: string; form: URLSearchParams }> = [];
      const responses: unknown[] = [
        { StagedPricingUploadId: 16104570 },
        {
          Success: true,
          Messages: [],
          StagedPricingUploadId: 16104570,
          SuccessfulProductCount: 1,
        },
        { success: true },
        {
          Success: [],
          Warning: [],
          Error: [],
          Update: [
            {
              ProductConditionId: 5199433,
              StorePriceCustomId: null,
              Message: null,
              ProductName: "Greninja Star",
              ChannelName: "Marketplace",
            },
          ],
        },
        { success: true },
      ];
      const post: SellerPortalFormPost = async <TResponse>(
        path: string,
        form: URLSearchParams,
      ): Promise<TResponse> => {
        calls.push({ path, form });
        return responses.shift() as TResponse;
      };

      const uploadId = await initializeStagedPricingImport(
        "inventory-batch-90.csv",
        post,
      );
      const uploadResult = await uploadStagedPricingChunk(
        {
          fileName: "inventory-batch-90.csv",
          uploadId,
          updates: [update],
        },
        post,
      );
      await finalizeStagedPricingImport(
        {
          uploadId,
          successfulProductCount: uploadResult.SuccessfulProductCount,
        },
        post,
      );
      const moveResult = await moveStagedPricingImportToLive(
        { uploadId },
        post,
      );
      await rollbackStagedPricingImport(uploadId, post);

      assert.deepEqual(
        calls.map((call) => call.path),
        [
          "/admin/pricing/initializeexportcsv",
          "/admin/pricing/uploadexportcsv",
          "/admin/pricing/finalizeexportcsv",
          "/admin/pricing/movetolive",
          "/admin/pricing/rollbackexportcsv",
        ],
      );
      assert.equal(moveResult.Update[0]?.ProductConditionId, 5199433);
    },
  },
  {
    name: "staged pricing operations reject unconfirmed responses",
    run: async () => {
      await assert.rejects(
        uploadStagedPricingChunk(
          {
            fileName: "inventory-batch-90.csv",
            uploadId: 16104570,
            updates: [update],
          },
          postResponse({
            Success: false,
            Messages: [],
            StagedPricingUploadId: 16104570,
            SuccessfulProductCount: 0,
          }),
        ),
        /did not accept staged pricing upload 16104570/,
      );
      await assert.rejects(
        finalizeStagedPricingImport(
          { uploadId: 16104570, successfulProductCount: 1 },
          postResponse({ success: false }),
        ),
        /did not finalize staged pricing upload 16104570/,
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
  console.log(`Passed ${testCases.length} staged pricing import client tests.`);
}
