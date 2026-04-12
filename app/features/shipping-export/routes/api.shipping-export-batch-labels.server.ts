import { data } from "react-router";
import { generateBatchLabelForPurchasedShipments } from "../services/easyPostPostage.server";
import type {
  EasyPostMode,
  LabelSize,
  ShippingPostageBatchLabelRequest,
  ShippingPostageBatchLabelRequestItem,
} from "../types/shippingExport";

type ShippingBatchLabelsActionDependencies = {
  generateBatchLabelForPurchasedShipments?: typeof generateBatchLabelForPurchasedShipments;
};

const EASYPOST_MODES = new Set<EasyPostMode>(["test", "production"]);
const LABEL_SIZES = new Set<LabelSize>(["4x6", "7x3", "6x4"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRequestItem(
  value: unknown,
): ShippingPostageBatchLabelRequestItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const item = value as Record<string, unknown>;
  const shipmentReference = isNonEmptyString(item.shipmentReference)
    ? item.shipmentReference.trim()
    : "";
  const easypostShipmentId = isNonEmptyString(item.easypostShipmentId)
    ? item.easypostShipmentId.trim()
    : "";

  if (!shipmentReference || !easypostShipmentId) {
    return null;
  }

  return {
    shipmentReference,
    easypostShipmentId,
  };
}

export function createShippingBatchLabelsAction(
  dependencies: ShippingBatchLabelsActionDependencies = {},
) {
  const generateBatchLabel =
    dependencies.generateBatchLabelForPurchasedShipments ??
    generateBatchLabelForPurchasedShipments;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as Partial<ShippingPostageBatchLabelRequest>;

      if (!payload.mode || !EASYPOST_MODES.has(payload.mode)) {
        return data(
          { error: "mode must be test or production." },
          { status: 400 },
        );
      }

      if (!payload.labelSize || !LABEL_SIZES.has(payload.labelSize)) {
        return data(
          { error: "labelSize must be one of 4x6, 7x3, or 6x4." },
          { status: 400 },
        );
      }

      if (!Array.isArray(payload.shipments) || payload.shipments.length === 0) {
        return data(
          { error: "shipments must be a non-empty array." },
          { status: 400 },
        );
      }

      const shipments = payload.shipments
        .map(validateRequestItem)
        .filter((item): item is ShippingPostageBatchLabelRequestItem => item !== null);

      if (shipments.length !== payload.shipments.length) {
        return data(
          {
            error:
              "Each shipment must include a shipmentReference and easypostShipmentId.",
          },
          { status: 400 },
        );
      }

      const result = await generateBatchLabel(payload.mode, shipments);
      return data(result, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
