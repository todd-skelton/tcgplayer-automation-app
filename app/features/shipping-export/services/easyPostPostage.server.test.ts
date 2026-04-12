import assert from "node:assert/strict";
import type { IBatch, IRate, IShipment } from "@easypost/api";
import {
  getPublicTrackingUrlForPurchasedShipment,
  generateBatchLabelForPurchasedShipments,
  purchaseShippingPostages,
} from "./easyPostPostage.server";
import type {
  CreateShippingPostagePurchaseInput,
  ShippingPostagePurchaseRecord,
} from "~/core/db/repositories/shippingPostagePurchases.server";
import type { ShippingPostagePurchaseRequestItem } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function createShipmentItem(
  overrides: Partial<ShippingPostagePurchaseRequestItem["shipment"]> = {},
): ShippingPostagePurchaseRequestItem {
  return {
    shipment: {
      reference: "1001",
      to_address: {
        name: "Jane Doe",
        street1: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        country: "US",
      },
      from_address: {
        name: "Warehouse",
        street1: "456 Commerce Blvd",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "US",
      },
      return_address: {
        name: "Warehouse",
        street1: "456 Commerce Blvd",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "US",
      },
      parcel: {
        length: 9,
        width: 6,
        height: 1,
        weight: 4,
        predefined_package: "Flat",
      },
      carrier: "USPS",
      service: "GroundAdvantage",
      options: {
        label_format: "PDF",
        label_size: "4x6",
        invoice_number: "1001",
        delivery_confirmation: "NO_SIGNATURE",
      },
      ...overrides,
    },
    orderNumbers: ["1001"],
  };
}

function createRate(
  overrides: Partial<IRate> = {},
): IRate {
  return {
    id: "rate_1",
    object: "Rate",
    created_at: "2026-04-11T00:00:00Z",
    updated_at: "2026-04-11T00:00:00Z",
    service: "GroundAdvantage",
    carrier: "USPS",
    carrier_account_id: "ca_123",
    shipment_id: "shp_123",
    rate: "4.11",
    currency: "USD",
    mode: "test",
    retail_rate: "5.00",
    retail_currency: "USD",
    list_rate: "4.25",
    list_currency: "USD",
    delivery_days: 4,
    delivery_date: "2026-04-15T00:00:00Z",
    delivery_date_guaranteed: false,
    est_delivery_days: 4,
    billing_type: "easypost",
    ...overrides,
  };
}

function createShipment(
  overrides: Partial<IShipment> = {},
): IShipment {
  return {
    id: "shp_123",
    object: "Shipment",
    mode: "test",
    reference: "1001",
    created_at: "2026-04-11T00:00:00Z",
    updated_at: "2026-04-11T00:00:00Z",
    to_address: {} as IShipment["to_address"],
    from_address: {} as IShipment["from_address"],
    return_address: null,
    buyer_address: null,
    parcel: {} as IShipment["parcel"],
    customs_info: null,
    scan_form: {} as IShipment["scan_form"],
    forms: [],
    insurance: {} as IShipment["insurance"],
    rates: [createRate()],
    selected_rate: createRate(),
    postage_label: {
      id: "pl_123",
      object: "PostageLabel",
      mode: "test",
      created_at: "2026-04-11T00:00:00Z",
      updated_at: "2026-04-11T00:00:00Z",
      date_advance: 0,
      integrated_form: "",
      label_date: "2026-04-11T00:00:00Z",
      label_resolution: 300,
      label_size: "4x6",
      label_type: "default",
      label_url: "https://example.com/label.png",
      label_file_type: "image/png",
      label_pdf_url: "https://example.com/label.pdf",
      label_epl2_url: "",
      label_zpl_url: "",
    },
    messages: [],
    options: null,
    is_return: false,
    tracking_code: "9400100000000000000000",
    usps_zone: "4",
    status: "unknown",
    tracker: {} as IShipment["tracker"],
    fees: [],
    refund_status: "submitted",
    batch_id: "",
    batch_status: "postage_purchased",
    batch_message: "",
    ...overrides,
  };
}

function createBatch(
  overrides: Partial<IBatch> = {},
): IBatch {
  return {
    id: "batch_123",
    object: "Batch",
    mode: "test",
    reference: "shipping-export-4x6",
    state: "label_generated",
    num_shipments: 1,
    shipments: [],
    status: {
      creation_failed: 0,
      created: 0,
      postage_purchased: 1,
      postage_purchase_failed: 0,
      queued_for_purchase: 0,
    },
    label_url: "https://example.com/batch-label.pdf",
    scan_form: {} as IBatch["scan_form"],
    pickup: {} as IBatch["pickup"],
    created_at: "2026-04-11T00:00:00Z",
    updated_at: "2026-04-11T00:00:00Z",
    ...overrides,
  };
}

function createClient(
  overrides: Partial<{
    Shipment: Partial<{
      create: (params: unknown) => Promise<IShipment>;
      buy: (id: string, rate: string | IRate) => Promise<IShipment>;
      retrieve: (id: string) => Promise<IShipment>;
    }>;
    Batch: Partial<{
      create: (params: { shipments: string[] }) => Promise<IBatch>;
      generateLabel: (id: string, fileFormat: "PDF") => Promise<IBatch>;
      retrieve: (id: string) => Promise<IBatch>;
    }>;
  }> = {},
) {
  return {
    Shipment: {
      async create() {
        return createShipment();
      },
      async buy() {
        return createShipment();
      },
      async retrieve() {
        return createShipment({
          tracker: {
            public_url: "https://track.easypost.com/example",
          } as IShipment["tracker"],
        });
      },
      ...overrides.Shipment,
    },
    Batch: {
      async create() {
        return createBatch({ state: "created", label_url: null });
      },
      async generateLabel() {
        return createBatch();
      },
      async retrieve() {
        return createBatch();
      },
      ...overrides.Batch,
    },
  };
}

function createRepository(
  overrides: Partial<{
    findSuccessfulOutboundByOrderNumbers: (
      mode: "test" | "production",
      orderNumbers: string[],
    ) => Promise<ShippingPostagePurchaseRecord[]>;
  }> = {},
) {
  const saved: CreateShippingPostagePurchaseInput[] = [];

  return {
    saved,
    repository: {
      async findSuccessfulOutboundByOrderNumbers() {
        return [];
      },
      async create(input: CreateShippingPostagePurchaseInput) {
        saved.push(input);
      },
      ...overrides,
    },
  };
}

const testCases: TestCase[] = [
  {
    name: "getPublicTrackingUrlForPurchasedShipment returns the EasyPost public tracker url",
    run: async () => {
      const trackingUrl = await getPublicTrackingUrlForPurchasedShipment(
        "production",
        "shp_123",
        {
          getApiKeyForMode: () => "prod-key",
          createClient: (apiKey) => {
            assert.equal(apiKey, "prod-key");

            return createClient({
              Shipment: {
                async retrieve(id) {
                  assert.equal(id, "shp_123");

                  return createShipment({
                    tracker: {
                      public_url: "https://track.easypost.com/trk_public",
                    } as IShipment["tracker"],
                  });
                },
              },
            });
          },
        },
      );

      assert.equal(trackingUrl, "https://track.easypost.com/trk_public");
    },
  },
  {
    name: "getPublicTrackingUrlForPurchasedShipment rejects shipments without a public tracker url",
    run: async () => {
      await assert.rejects(
        () =>
          getPublicTrackingUrlForPurchasedShipment("test", "shp_123", {
            getApiKeyForMode: () => "test-key",
            createClient: () =>
              createClient({
                Shipment: {
                  async retrieve() {
                    return createShipment({
                      tracker: {} as IShipment["tracker"],
                    });
                  },
                },
              }),
          }),
        /does not have a public tracking URL/,
      );
    },
  },
  {
    name: "purchaseShippingPostages resolves the requested mode to the configured API key",
    run: async () => {
      const item = createShipmentItem();
      let capturedMode: string | null = null;
      let capturedApiKey: string | null = null;
      const { repository } = createRepository();

      await purchaseShippingPostages("production", "4x6", [item], {
        getApiKeyForMode: (mode) => {
          capturedMode = mode;
          return "prod-key";
        },
        createClient: (apiKey) => {
          capturedApiKey = apiKey;
          return createClient();
        },
        postagePurchasesRepository: repository as never,
      });

      assert.equal(capturedMode, "production");
      assert.equal(capturedApiKey, "prod-key");
    },
  },
  {
    name: "purchaseShippingPostages rejects when the selected mode has no API key",
    run: async () => {
      await assert.rejects(
        purchaseShippingPostages("test", "4x6", [createShipmentItem()], {
          getApiKeyForMode: () => {
            throw new Error("Missing EASYPOST_TEST_API_KEY");
          },
        }),
        /Missing EASYPOST_TEST_API_KEY/,
      );
    },
  },
  {
    name: "purchaseShippingPostages buys the lowest matching USPS service rate",
    run: async () => {
      const { saved, repository } = createRepository();
      const createCalls: unknown[] = [];
      const buyCalls: Array<string | IRate> = [];
      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create(params) {
                  createCalls.push(params);
                  return createShipment({
                    rates: [
                      createRate({ id: "rate_high", rate: "5.00" }),
                      createRate({ id: "rate_low", rate: "4.11" }),
                      createRate({
                        id: "rate_priority",
                        rate: "6.50",
                        service: "Priority",
                      }),
                    ],
                  });
                },
                async buy(_id, rate) {
                  buyCalls.push(rate);
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(createCalls.length, 1);
      assert.equal(buyCalls.length, 1);
      assert.equal(response.results[0].status, "purchased");
      assert.equal(response.results[0].selectedRate?.rate, "4.11");
      assert.equal(saved[0].status, "purchased");
    },
  },
  {
    name: "purchaseShippingPostages fails when no matching USPS service rate exists",
    run: async () => {
      const { saved, repository } = createRepository();
      let buyCalled = false;

      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  return createShipment({
                    rates: [createRate({ service: "Priority" })],
                  });
                },
                async buy() {
                  buyCalled = true;
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(buyCalled, false);
      assert.equal(response.results[0].status, "failed");
      assert.match(
        response.results[0].error ?? "",
        /No USPS GroundAdvantage rate was available/,
      );
      assert.equal(saved[0].status, "failed");
    },
  },
  {
    name: "purchaseShippingPostages normalizes EasyPost API errors into readable failures",
    run: async () => {
      const { repository } = createRepository();
      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  const error = Object.assign(new Error("Invalid address"), {
                    code: "ADDRESS.VERIFY.FAILURE",
                    statusCode: 422,
                    errors: [
                      {
                        field: "to_address.street1",
                        message: "is invalid",
                      },
                    ],
                  });
                  throw error;
                },
                async buy() {
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(response.results[0].status, "failed");
      assert.match(response.results[0].error ?? "", /code=ADDRESS\.VERIFY\.FAILURE/);
      assert.match(response.results[0].error ?? "", /status=422/);
      assert.match(response.results[0].error ?? "", /to_address\.street1: is invalid/);
    },
  },
  {
    name: "purchaseShippingPostages skips duplicates already purchased in the same mode",
    run: async () => {
      let createCalled = false;
      const { repository } = createRepository({
        async findSuccessfulOutboundByOrderNumbers() {
          return [
            {
              id: 1,
              shipmentReference: "1001",
              orderNumbers: ["1001"],
              mode: "test",
              direction: "outbound",
              labelSize: "4x6",
              easypostShipmentId: "shp_existing",
              trackingCode: "9400",
              selectedRateService: "GroundAdvantage",
              selectedRateRate: "4.11",
              selectedRateCurrency: "USD",
              labelUrl: null,
              labelPdfUrl: null,
              status: "purchased",
              errorMessage: null,
              createdAt: new Date(),
            },
          ];
        },
      });

      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  createCalled = true;
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(createCalled, false);
      assert.equal(response.results[0].status, "skipped");
      assert.match(response.results[0].error ?? "", /already purchased/);
    },
  },
  {
    name: "purchaseShippingPostages allows single outbound repurchases for the same order",
    run: async () => {
      let createCalled = false;
      let duplicateLookupCount = 0;
      const { saved, repository } = createRepository({
        async findSuccessfulOutboundByOrderNumbers() {
          duplicateLookupCount += 1;
          return [
            {
              id: 1,
              shipmentReference: "1001",
              orderNumbers: ["1001"],
              mode: "test",
              direction: "outbound",
              labelSize: "4x6",
              easypostShipmentId: "shp_existing",
              trackingCode: "9400",
              selectedRateService: "GroundAdvantage",
              selectedRateRate: "4.11",
              selectedRateCurrency: "USD",
              labelUrl: null,
              labelPdfUrl: null,
              status: "purchased",
              errorMessage: null,
              createdAt: new Date(),
            },
          ];
        },
      });

      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          direction: "outbound",
          purchaseScope: "single",
        },
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  createCalled = true;
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(duplicateLookupCount, 0);
      assert.equal(createCalled, true);
      assert.equal(response.results[0].status, "purchased");
      assert.equal(saved[0].direction, "outbound");
      assert.equal(response.batchLabel.status, "skipped");
    },
  },
  {
    name: "purchaseShippingPostages allows return labels and persists return direction",
    run: async () => {
      let createCalled = false;
      let duplicateLookupCount = 0;
      const { saved, repository } = createRepository({
        async findSuccessfulOutboundByOrderNumbers() {
          duplicateLookupCount += 1;
          return [];
        },
      });

      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          direction: "return",
          purchaseScope: "single",
        },
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  createCalled = true;
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(duplicateLookupCount, 0);
      assert.equal(createCalled, true);
      assert.equal(response.results[0].status, "purchased");
      assert.equal(saved[0].direction, "return");
      assert.equal(response.batchLabel.status, "skipped");
    },
  },
  {
    name: "purchaseShippingPostages skips non-US shipments in v1",
    run: async () => {
      let createCalled = false;
      const { repository } = createRepository();
      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [
          createShipmentItem({
            to_address: {
              name: "Jane Doe",
              street1: "123 Main St",
              city: "Toronto",
              state: "ON",
              zip: "M5V 2T6",
              country: "CA",
            },
          }),
        ],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  createCalled = true;
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(createCalled, false);
      assert.equal(response.results[0].status, "skipped");
      assert.match(response.results[0].error ?? "", /US domestic shipments/);
    },
  },
  {
    name: "purchaseShippingPostages returns a combined batch PDF for purchased shipments",
    run: async () => {
      const { repository } = createRepository();
      let capturedBatchShipments: string[] = [];
      let generatedBatchId: string | null = null;
      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Batch: {
                async create(params) {
                  capturedBatchShipments = params.shipments;
                  return createBatch({
                    id: "batch_ready",
                    state: "created",
                    label_url: null,
                  });
                },
                async generateLabel(batchId) {
                  generatedBatchId = batchId;
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/batches/4x6.pdf",
                  });
                },
                async retrieve(batchId) {
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/batches/4x6.pdf",
                  });
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.deepEqual(capturedBatchShipments, ["shp_123"]);
      assert.equal(generatedBatchId, "batch_ready");
      assert.deepEqual(response.batchLabel, {
        status: "ready",
        shipmentReferences: ["1001"],
        batchId: "batch_ready",
        labelUrl: "https://example.com/batches/4x6.pdf",
      });
    },
  },
  {
    name: "purchaseShippingPostages preserves duplicate shipment metadata for batch labels",
    run: async () => {
      const { repository } = createRepository({
        async findSuccessfulOutboundByOrderNumbers() {
          return [
            {
              id: 1,
              shipmentReference: "1001",
              orderNumbers: ["1001"],
              mode: "test",
              direction: "outbound",
              labelSize: "4x6",
              easypostShipmentId: "shp_existing",
              trackingCode: "9400",
              selectedRateService: "GroundAdvantage",
              selectedRateRate: "4.11",
              selectedRateCurrency: "USD",
              labelUrl: "https://example.com/label.png",
              labelPdfUrl: "https://example.com/label.pdf",
              status: "purchased",
              errorMessage: null,
              createdAt: new Date(),
            },
          ];
        },
      });
      let createShipmentCalled = false;
      let batchShipments: string[] = [];
      const response = await purchaseShippingPostages(
        "test",
        "4x6",
        [createShipmentItem()],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () =>
            createClient({
              Shipment: {
                async create() {
                  createShipmentCalled = true;
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
              Batch: {
                async create(params) {
                  batchShipments = params.shipments;
                  return createBatch({
                    id: "batch_existing",
                    state: "created",
                    label_url: null,
                  });
                },
                async generateLabel(batchId) {
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/existing-batch.pdf",
                  });
                },
                async retrieve(batchId) {
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/existing-batch.pdf",
                  });
                },
              },
            }),
          postagePurchasesRepository: repository as never,
        },
      );

      assert.equal(createShipmentCalled, false);
      assert.deepEqual(batchShipments, ["shp_existing"]);
      assert.equal(response.results[0].easypostShipmentId, "shp_existing");
      assert.equal(response.results[0].labelPdfUrl, "https://example.com/label.pdf");
      assert.equal(response.batchLabel.labelUrl, "https://example.com/existing-batch.pdf");
    },
  },
  {
    name: "generateBatchLabelForPurchasedShipments creates a batch pdf from saved shipments",
    run: async () => {
      let capturedApiKey: string | null = null;
      let capturedBatchShipments: string[] = [];

      const result = await generateBatchLabelForPurchasedShipments(
        "production",
        [
          {
            shipmentReference: "1001",
            easypostShipmentId: "shp_saved_1",
          },
          {
            shipmentReference: "1002",
            easypostShipmentId: "shp_saved_2",
          },
        ],
        {
          getApiKeyForMode: () => "prod-key",
          createClient: (apiKey) => {
            capturedApiKey = apiKey;
            return createClient({
              Batch: {
                async create(params) {
                  capturedBatchShipments = params.shipments;
                  return createBatch({
                    id: "batch_saved",
                    state: "created",
                    label_url: null,
                  });
                },
                async generateLabel(batchId) {
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/saved-batch.pdf",
                  });
                },
                async retrieve(batchId) {
                  return createBatch({
                    id: batchId,
                    state: "label_generated",
                    label_url: "https://example.com/saved-batch.pdf",
                  });
                },
              },
            });
          },
        },
      );

      assert.equal(capturedApiKey, "prod-key");
      assert.deepEqual(capturedBatchShipments, ["shp_saved_1", "shp_saved_2"]);
      assert.deepEqual(result, {
        status: "ready",
        shipmentReferences: ["1001", "1002"],
        batchId: "batch_saved",
        labelUrl: "https://example.com/saved-batch.pdf",
      });
    },
  },
  {
    name: "generateBatchLabelForPurchasedShipments preserves EasyPost batch retrieve context while polling",
    run: async () => {
      const result = await generateBatchLabelForPurchasedShipments(
        "test",
        [
          {
            shipmentReference: "1001",
            easypostShipmentId: "shp_saved_1",
          },
        ],
        {
          getApiKeyForMode: () => "test-key",
          createClient: () => {
            const batchStatesById: Record<string, IBatch[]> = {
              batch_ctx: [
                createBatch({
                  id: "batch_ctx",
                  state: "created",
                  label_url: null,
                }),
              ],
            };

            return {
              Shipment: {
                async create() {
                  return createShipment();
                },
                async buy() {
                  return createShipment();
                },
              },
              Batch: {
                async create() {
                  return createBatch({
                    id: "batch_ctx",
                    state: "creating",
                    label_url: null,
                  });
                },
                async generateLabel(batchId: string) {
                  batchStatesById[batchId] = [
                    createBatch({
                      id: batchId,
                      state: "label_generated",
                      label_url: "https://example.com/context-batch.pdf",
                    }),
                  ];

                  return createBatch({
                    id: batchId,
                    state: "label_generating",
                    label_url: null,
                  });
                },
                async retrieve(
                  this: { _batchStatesById: typeof batchStatesById },
                  batchId: string,
                ) {
                  const states = this._batchStatesById[batchId];

                  if (!states || states.length === 0) {
                    throw new Error(`Missing batch state for ${batchId}`);
                  }

                  return states.length > 1 ? states.shift()! : states[0];
                },
                _batchStatesById: batchStatesById,
              },
            } as never;
          },
        },
      );

      assert.deepEqual(result, {
        status: "ready",
        shipmentReferences: ["1001"],
        batchId: "batch_ctx",
        labelUrl: "https://example.com/context-batch.pdf",
      });
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
  console.log(`Passed ${testCases.length} EasyPost postage service tests.`);
}
