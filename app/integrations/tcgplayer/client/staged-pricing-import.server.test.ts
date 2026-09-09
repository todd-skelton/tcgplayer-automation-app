import assert from "node:assert/strict";
import type { SafeHttpResponseMetadata } from "~/core/clients/baseDomainClient.server";
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
  StagedPricingInitializationError,
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

function observedPostResponse(
  response: unknown,
  metadata: SafeHttpResponseMetadata = {
    status: 200,
    contentType: "json",
    redirected: false,
  },
): SellerPortalFormPost {
  return async <TResponse>(
    _path: string,
    _form: URLSearchParams,
    observeResponse?: (metadata: SafeHttpResponseMetadata) => void,
  ): Promise<TResponse> => {
    observeResponse?.(metadata);
    return response as TResponse;
  };
}

function rejectedPost(error: unknown): SellerPortalFormPost {
  return async <TResponse>(): Promise<TResponse> => {
    throw error;
  };
}

function rejectedHttpPost(
  status: number,
  response: unknown,
  metadata: SafeHttpResponseMetadata = {
    status,
    contentType: "json",
    redirected: false,
  },
): SellerPortalFormPost {
  return async <TResponse>(
    _path: string,
    _form: URLSearchParams,
    observeResponse?: (metadata: SafeHttpResponseMetadata) => void,
  ): Promise<TResponse> => {
    observeResponse?.(metadata);
    throw {
      isAxiosError: true,
      code: status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
      response: { status, data: response },
    };
  };
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
  {
    name: "staged pricing initialization accepts only the observed safe numeric identity",
    run: async () => {
      let invalidFilePostCalls = 0;
      await assert.rejects(
        initializeStagedPricingImport(" ", async <TResponse>() => {
          invalidFilePostCalls += 1;
          return {} as TResponse;
        }),
        RangeError,
      );
      assert.equal(invalidFilePostCalls, 0);

      assert.equal(
        await initializeStagedPricingImport(
          "observed-contract.csv",
          observedPostResponse({ StagedPricingUploadId: 16104570 }),
        ),
        16104570,
      );

      const invalidResponses: unknown[] = [
        { StagedPricingUploadId: "16104570" },
        {},
        { StagedPricingUploadId: null },
        { StagedPricingUploadId: 0 },
        { StagedPricingUploadId: -1 },
        { StagedPricingUploadId: 1.5 },
        { StagedPricingUploadId: Number.MAX_SAFE_INTEGER + 1 },
        "<html><body>Unexpected response</body></html>",
      ];
      for (const response of invalidResponses) {
        await assert.rejects(
          initializeStagedPricingImport(
            "invalid-contract.csv",
            observedPostResponse(response),
          ),
          (error: unknown) =>
            error instanceof StagedPricingInitializationError &&
            error.code === "staged_initialization_response_invalid" &&
            error.message.includes("status=200") &&
            !error.message.includes("Unexpected response"),
        );
      }
    },
  },
  {
    name: "staged pricing initialization classifies login, challenge, and rejection without body text",
    run: async () => {
      const cases: Array<{
        response: unknown;
        metadata?: SafeHttpResponseMetadata;
        code: StagedPricingInitializationError["code"];
        secret: string;
      }> = [
        {
          response:
            '<!doctype html><html><form action="/login">Sign in private</form></html>',
          metadata: {
            status: 200,
            contentType: "html",
            redirected: true,
          },
          code: "staged_initialization_authentication_required",
          secret: "private",
        },
        {
          response:
            "<!doctype html><html><div>Verify you are human private</div></html>",
          metadata: {
            status: 200,
            contentType: "html",
            redirected: false,
          },
          code: "staged_initialization_challenge",
          secret: "private",
        },
        {
          response: {
            Success: false,
            Messages: ["private provider explanation"],
          },
          code: "staged_initialization_rejected",
          secret: "private provider explanation",
        },
        {
          response: {
            StagedPricingUploadId: 16104570,
            success: false,
            error: "private contradictory response",
          },
          code: "staged_initialization_rejected",
          secret: "private contradictory response",
        },
      ];

      for (const testCase of cases) {
        await assert.rejects(
          initializeStagedPricingImport(
            "classified-contract.csv",
            observedPostResponse(testCase.response, testCase.metadata),
          ),
          (error: unknown) =>
            error instanceof StagedPricingInitializationError &&
            error.code === testCase.code &&
            !error.message.includes(testCase.secret),
        );
      }
    },
  },
  {
    name: "staged pricing initialization classifies rejected HTTP bodies without accepting their IDs",
    run: async () => {
      const cases: Array<{
        status: number;
        response: unknown;
        metadata?: SafeHttpResponseMetadata;
        code: StagedPricingInitializationError["code"];
      }> = [
        {
          status: 400,
          response: { Success: false, Messages: ["private"] },
          code: "staged_initialization_rejected",
        },
        {
          status: 403,
          response: "<html><div>Verify you are human private</div></html>",
          metadata: {
            status: 403,
            contentType: "html",
            redirected: false,
          },
          code: "staged_initialization_challenge",
        },
        {
          status: 400,
          response: { StagedPricingUploadId: 16104570 },
          code: "staged_initialization_rejected",
        },
        {
          status: 500,
          response: { StagedPricingUploadId: 16104570 },
          code: "staged_initialization_transport_failed",
        },
      ];

      for (const testCase of cases) {
        await assert.rejects(
          initializeStagedPricingImport(
            "rejected-http.csv",
            rejectedHttpPost(
              testCase.status,
              testCase.response,
              testCase.metadata,
            ),
          ),
          (error: unknown) =>
            error instanceof StagedPricingInitializationError &&
            error.code === testCase.code &&
            !error.message.includes("private"),
        );
      }
    },
  },
  {
    name: "staged pricing initialization sanitizes transport failures and preserves their phase",
    run: async () => {
      await assert.rejects(
        initializeStagedPricingImport(
          "transport-failure.csv",
          rejectedPost({
            name: "AxiosError",
            code: "ECONNABORTED",
            message: "private request details",
            config: { headers: { Cookie: "private cookie" } },
          }),
        ),
        (error: unknown) =>
          error instanceof StagedPricingInitializationError &&
          error.code === "staged_initialization_transport_failed" &&
          error.message.includes("before a response was confirmed") &&
          error.message.includes("transport=ECONNABORTED") &&
          !error.message.includes("private"),
      );
      await assert.rejects(
        initializeStagedPricingImport(
          "authentication-failure.csv",
          rejectedPost({
            code: "ERR_BAD_REQUEST",
            response: { status: 401, data: "private response" },
          }),
        ),
        (error: unknown) =>
          error instanceof StagedPricingInitializationError &&
          error.code === "staged_initialization_authentication_required" &&
          !error.message.includes("private"),
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
