import EasyPostClient, {
  type IBatch,
  type IRate,
  type IShipment,
  type IShipmentCreateParameters,
} from "@easypost/api";
import { shippingPostagePurchasesRepository } from "~/core/db";
import type { ShippingPostagePurchaseRecord } from "~/core/db/repositories/shippingPostagePurchases.server";
import { getEasyPostApiKey } from "../config/easyPostConfig.server";
import type {
  EasyPostMode,
  EasyPostShipment,
  LabelSize,
  ShippingPostageBatchLabelRequestItem,
  ShippingPostageBatchLabelResult,
  ShippingPostagePurchaseRequestItem,
  ShippingPostagePurchaseResponse,
  ShippingPostagePurchaseResult,
} from "../types/shippingExport";

type EasyPostClientLike = {
  Batch: {
    create: (params: { shipments: string[] }) => Promise<IBatch>;
    generateLabel: (id: string, fileFormat: "PDF") => Promise<IBatch>;
    retrieve: (id: string) => Promise<IBatch>;
  };
  Shipment: {
    create: (params: IShipmentCreateParameters) => Promise<IShipment>;
    buy: (id: string, rate: string | IRate) => Promise<IShipment>;
  };
};

type ShippingPostagePurchasesRepositoryLike =
  typeof shippingPostagePurchasesRepository;

type PurchaseShippingPostagesDependencies = {
  createClient?: (apiKey: string) => EasyPostClientLike;
  getApiKeyForMode?: (mode: EasyPostMode) => string;
  postagePurchasesRepository?: ShippingPostagePurchasesRepositoryLike;
};

const BATCH_FAILURE_STATES = new Set(["creation_failed", "purchase_failed"]);
const BATCH_READY_STATES = new Set(["created", "purchased", "label_generated"]);
const BATCH_LABEL_READY_STATE = "label_generated";
const BATCH_POLL_ATTEMPTS = 15;
const BATCH_POLL_INTERVAL_MS = 1000;

function normalizeServiceName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function formatEasyPostError(error: unknown): string {
  if (error instanceof Error) {
    const errorLike = error as Error & {
      code?: string;
      statusCode?: number;
      errors?: Array<{ field?: string; message?: string }>;
    };

    const nestedErrors =
      errorLike.errors
        ?.map((item) => {
          const prefix = item.field ? `${item.field}: ` : "";
          return `${prefix}${item.message ?? "Unknown field error"}`;
        })
        .filter(Boolean)
        .join("; ") ?? "";

    const segments = [
      errorLike.code ? `code=${errorLike.code}` : null,
      errorLike.statusCode ? `status=${errorLike.statusCode}` : null,
      errorLike.message,
      nestedErrors || null,
    ].filter(Boolean);

    return segments.join(" | ");
  }

  return String(error);
}

function selectLowestMatchingRate(
  rates: IRate[] | undefined,
  shipment: EasyPostShipment,
): IRate | null {
  const matchingRates = (rates ?? []).filter(
    (rate) =>
      rate.carrier.toUpperCase() === shipment.carrier &&
      normalizeServiceName(rate.service) ===
        normalizeServiceName(shipment.service),
  );

  if (matchingRates.length === 0) {
    return null;
  }

  return [...matchingRates].sort(
    (left, right) => Number(left.rate) - Number(right.rate),
  )[0];
}

function toEasyPostShipmentCreateParameters(
  shipment: EasyPostShipment,
): IShipmentCreateParameters {
  return {
    reference: shipment.reference,
    to_address: { ...shipment.to_address },
    from_address: { ...shipment.from_address },
    parcel: {
      length: shipment.parcel.length,
      width: shipment.parcel.width,
      height: shipment.parcel.height,
      weight: shipment.parcel.weight,
      predefined_package: shipment.parcel.predefined_package,
    },
    options: {
      label_format: shipment.options.label_format,
      invoice_number: shipment.options.invoice_number,
      delivery_confirmation: shipment.options.delivery_confirmation,
      label_size: shipment.options.label_size,
    },
    return_address: { ...shipment.return_address },
  } as IShipmentCreateParameters;
}

function toRateSummary(
  record: Pick<
    ShippingPostagePurchaseRecord,
    "selectedRateService" | "selectedRateRate" | "selectedRateCurrency"
  >,
) {
  if (
    !record.selectedRateService ||
    !record.selectedRateRate ||
    !record.selectedRateCurrency
  ) {
    return undefined;
  }

  return {
    service: record.selectedRateService,
    rate: record.selectedRateRate,
    currency: record.selectedRateCurrency,
  };
}

async function persistPurchaseResult(
  repository: ShippingPostagePurchasesRepositoryLike,
  mode: EasyPostMode,
  labelSize: LabelSize,
  result: ShippingPostagePurchaseResult,
): Promise<void> {
  await repository.create({
    shipmentReference: result.reference,
    orderNumbers: result.orderNumbers,
    mode,
    labelSize,
    easypostShipmentId: result.easypostShipmentId,
    trackingCode: result.trackingCode,
    selectedRateService: result.selectedRate?.service,
    selectedRateRate: result.selectedRate?.rate,
    selectedRateCurrency: result.selectedRate?.currency,
    labelUrl: result.labelUrl,
    labelPdfUrl: result.labelPdfUrl,
    status: result.status,
    errorMessage: result.error,
  });
}

function createSkippedResult(
  item: ShippingPostagePurchaseRequestItem,
  error: string,
  existingPurchase?: ShippingPostagePurchaseRecord,
): ShippingPostagePurchaseResult {
  return {
    reference: item.shipment.reference,
    orderNumbers: item.orderNumbers,
    status: "skipped",
    easypostShipmentId: existingPurchase?.easypostShipmentId ?? undefined,
    trackingCode: existingPurchase?.trackingCode ?? undefined,
    selectedRate: existingPurchase
      ? toRateSummary(existingPurchase)
      : undefined,
    labelUrl: existingPurchase?.labelUrl ?? undefined,
    labelPdfUrl: existingPurchase?.labelPdfUrl ?? undefined,
    error,
  };
}

function createFailedResult(
  item: ShippingPostagePurchaseRequestItem,
  error: string,
): ShippingPostagePurchaseResult {
  return {
    reference: item.shipment.reference,
    orderNumbers: item.orderNumbers,
    status: "failed",
    error,
  };
}

function hasBatchFailureState(batch: Pick<IBatch, "state">): boolean {
  return BATCH_FAILURE_STATES.has(batch.state);
}

function hasBatchReadyState(batch: Pick<IBatch, "state">): boolean {
  return BATCH_READY_STATES.has(batch.state);
}

function hasGeneratedBatchLabel(
  batch: Pick<IBatch, "state" | "label_url">,
): boolean {
  return batch.state === BATCH_LABEL_READY_STATE || Boolean(batch.label_url);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForBatchState(
  retrieveBatch: EasyPostClientLike["Batch"]["retrieve"],
  initialBatch: IBatch,
  isReady: (batch: IBatch) => boolean,
): Promise<{ batch: IBatch; timedOut: boolean }> {
  let batch = initialBatch;

  if (isReady(batch) || hasBatchFailureState(batch)) {
    return { batch, timedOut: false };
  }

  for (let attempt = 0; attempt < BATCH_POLL_ATTEMPTS; attempt += 1) {
    await delay(BATCH_POLL_INTERVAL_MS);
    batch = await retrieveBatch(initialBatch.id);

    if (isReady(batch) || hasBatchFailureState(batch)) {
      return { batch, timedOut: false };
    }
  }

  return { batch, timedOut: true };
}

async function createBatchLabel(
  client: EasyPostClientLike,
  results: ShippingPostagePurchaseResult[],
): Promise<ShippingPostageBatchLabelResult> {
  const eligibleResults = results.filter(
    (
      result,
    ): result is ShippingPostagePurchaseResult & {
      easypostShipmentId: string;
    } =>
      typeof result.easypostShipmentId === "string" &&
      result.easypostShipmentId.trim().length > 0,
  );
  const shipmentReferences = eligibleResults.map((result) => result.reference);
  const shipmentIds = [
    ...new Set(eligibleResults.map((result) => result.easypostShipmentId)),
  ];

  if (shipmentIds.length === 0) {
    return {
      status: "skipped",
      shipmentReferences,
      message:
        "No purchased EasyPost shipments were available to combine into a batch PDF.",
    };
  }

  try {
    const createdBatch = await client.Batch.create({ shipments: shipmentIds });
    const createdBatchState = await waitForBatchState(
      (batchId) => client.Batch.retrieve(batchId),
      createdBatch,
      hasBatchReadyState,
    );

    if (hasBatchFailureState(createdBatchState.batch)) {
      return {
        status: "failed",
        shipmentReferences,
        batchId: createdBatchState.batch.id,
        message: `EasyPost batch creation ended in ${createdBatchState.batch.state}.`,
      };
    }

    if (createdBatchState.timedOut) {
      return {
        status: "pending",
        shipmentReferences,
        batchId: createdBatchState.batch.id,
        message:
          "EasyPost is still preparing the batch. Try opening the batch PDF again in a moment.",
      };
    }

    const generatedBatch = await client.Batch.generateLabel(
      createdBatchState.batch.id,
      "PDF",
    );
    const generatedBatchState = await waitForBatchState(
      (batchId) => client.Batch.retrieve(batchId),
      generatedBatch,
      hasGeneratedBatchLabel,
    );

    if (hasBatchFailureState(generatedBatchState.batch)) {
      return {
        status: "failed",
        shipmentReferences,
        batchId: generatedBatchState.batch.id,
        message: `EasyPost batch label generation ended in ${generatedBatchState.batch.state}.`,
      };
    }

    if (generatedBatchState.batch.label_url) {
      return {
        status: "ready",
        shipmentReferences,
        batchId: generatedBatchState.batch.id,
        labelUrl: generatedBatchState.batch.label_url,
      };
    }

    if (generatedBatchState.timedOut) {
      return {
        status: "pending",
        shipmentReferences,
        batchId: generatedBatchState.batch.id,
        message: "EasyPost is still generating the combined batch PDF.",
      };
    }

    return {
      status: "failed",
      shipmentReferences,
      batchId: generatedBatchState.batch.id,
      message: "EasyPost did not return a combined batch PDF URL.",
    };
  } catch (error) {
    return {
      status: "failed",
      shipmentReferences,
      message: formatEasyPostError(error),
    };
  }
}

export async function generateBatchLabelForPurchasedShipments(
  mode: EasyPostMode,
  shipments: ShippingPostageBatchLabelRequestItem[],
  dependencies: PurchaseShippingPostagesDependencies = {},
): Promise<ShippingPostageBatchLabelResult> {
  const getApiKeyForMode = dependencies.getApiKeyForMode ?? getEasyPostApiKey;
  const createClient =
    dependencies.createClient ??
    ((apiKey: string) => new EasyPostClient(apiKey) as EasyPostClientLike);
  const client = createClient(getApiKeyForMode(mode));

  return createBatchLabel(
    client,
    shipments.map((shipment) => ({
      reference: shipment.shipmentReference,
      orderNumbers: [shipment.shipmentReference],
      status: "purchased",
      easypostShipmentId: shipment.easypostShipmentId,
    })),
  );
}

export async function purchaseShippingPostages(
  mode: EasyPostMode,
  labelSize: LabelSize,
  items: ShippingPostagePurchaseRequestItem[],
  dependencies: PurchaseShippingPostagesDependencies = {},
): Promise<ShippingPostagePurchaseResponse> {
  const getApiKeyForMode = dependencies.getApiKeyForMode ?? getEasyPostApiKey;
  const createClient =
    dependencies.createClient ??
    ((apiKey: string) => new EasyPostClient(apiKey) as EasyPostClientLike);
  const repository =
    dependencies.postagePurchasesRepository ??
    shippingPostagePurchasesRepository;

  const client = createClient(getApiKeyForMode(mode));
  const results: ShippingPostagePurchaseResult[] = [];

  for (const item of items) {
    const normalizedOrderNumbers = item.orderNumbers
      .map((orderNumber) => orderNumber.trim())
      .filter(Boolean);

    const duplicatePurchases =
      await repository.findSuccessfulOutboundByOrderNumbers(
        mode,
        normalizedOrderNumbers,
      );

    if (duplicatePurchases.length > 0) {
      const result = createSkippedResult(
        item,
        `Postage already purchased in ${mode} mode for order ${duplicatePurchases[0].orderNumbers[0]}.`,
        duplicatePurchases[0],
      );
      await persistPurchaseResult(repository, mode, labelSize, result);
      results.push(result);
      continue;
    }

    if (item.shipment.to_address.country.toUpperCase() !== "US") {
      const result = createSkippedResult(
        item,
        "Direct EasyPost purchase is limited to US domestic shipments in v1.",
      );
      await persistPurchaseResult(repository, mode, labelSize, result);
      results.push(result);
      continue;
    }

    try {
      const createdShipment = await client.Shipment.create(
        toEasyPostShipmentCreateParameters(item.shipment),
      );
      const selectedRate = selectLowestMatchingRate(
        createdShipment.rates,
        item.shipment,
      );

      if (!selectedRate) {
        const result = createFailedResult(
          item,
          `No USPS ${item.shipment.service} rate was available for this shipment.`,
        );
        await persistPurchaseResult(repository, mode, labelSize, result);
        results.push(result);
        continue;
      }

      const boughtShipment = await client.Shipment.buy(
        createdShipment.id,
        selectedRate,
      );

      const result: ShippingPostagePurchaseResult = {
        reference: item.shipment.reference,
        orderNumbers: normalizedOrderNumbers,
        status: "purchased",
        easypostShipmentId: boughtShipment.id,
        trackingCode: boughtShipment.tracking_code,
        selectedRate: {
          service: selectedRate.service,
          rate: selectedRate.rate,
          currency: selectedRate.currency,
        },
        labelUrl: boughtShipment.postage_label?.label_url,
        labelPdfUrl: boughtShipment.postage_label?.label_pdf_url,
      };

      await persistPurchaseResult(repository, mode, labelSize, result);
      results.push(result);
    } catch (error) {
      const result = createFailedResult(item, formatEasyPostError(error));
      await persistPurchaseResult(repository, mode, labelSize, result);
      results.push(result);
    }
  }

  const batchLabel = await createBatchLabel(client, results);

  return {
    mode,
    batchLabel,
    results,
  };
}
