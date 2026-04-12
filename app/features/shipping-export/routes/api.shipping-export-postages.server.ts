import { data } from "react-router";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import { purchaseShippingPostages } from "../services/easyPostPostage.server";
import type {
  EasyPostAddress,
  EasyPostShipment,
  LabelFormat,
  LabelSize,
  ShippingPostagePurchaseRequest,
  ShippingPostagePurchaseRequestItem,
} from "../types/shippingExport";

type ShippingPostageActionDependencies = {
  getShippingExportConfig?: typeof getShippingExportConfig;
  purchaseShippingPostages?: typeof purchaseShippingPostages;
};

const LABEL_SIZES = new Set<LabelSize>(["4x6", "7x3", "6x4"]);
const LABEL_FORMATS = new Set<LabelFormat>(["PDF", "PNG"]);
const SERVICES = new Set(["First", "GroundAdvantage", "Priority", "Express"]);
const DELIVERY_CONFIRMATIONS = new Set(["NO_SIGNATURE", "SIGNATURE"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidAddress(value: unknown): value is EasyPostAddress {
  if (!value || typeof value !== "object") {
    return false;
  }

  const address = value as Record<string, unknown>;
  return (
    isNonEmptyString(address.name) &&
    isNonEmptyString(address.street1) &&
    isNonEmptyString(address.city) &&
    isNonEmptyString(address.state) &&
    isNonEmptyString(address.zip) &&
    isNonEmptyString(address.country)
  );
}

function isValidShipment(
  value: unknown,
  labelSize: LabelSize,
): value is EasyPostShipment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const shipment = value as Record<string, unknown>;
  const parcel = shipment.parcel as Record<string, unknown> | undefined;
  const options = shipment.options as Record<string, unknown> | undefined;

  return (
    isNonEmptyString(shipment.reference) &&
    shipment.carrier === "USPS" &&
    typeof shipment.service === "string" &&
    SERVICES.has(shipment.service) &&
    isValidAddress(shipment.to_address) &&
    isValidAddress(shipment.from_address) &&
    isValidAddress(shipment.return_address) &&
    !!parcel &&
    isFiniteNumber(parcel.length) &&
    isFiniteNumber(parcel.width) &&
    isFiniteNumber(parcel.height) &&
    isFiniteNumber(parcel.weight) &&
    isNonEmptyString(parcel.predefined_package) &&
    !!options &&
    isNonEmptyString(options.invoice_number) &&
    typeof options.label_format === "string" &&
    LABEL_FORMATS.has(options.label_format as LabelFormat) &&
    typeof options.label_size === "string" &&
    options.label_size === labelSize &&
    DELIVERY_CONFIRMATIONS.has(String(options.delivery_confirmation))
  );
}

function validateRequestItem(
  value: unknown,
  labelSize: LabelSize,
): ShippingPostagePurchaseRequestItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const item = value as Record<string, unknown>;
  const orderNumbers = Array.isArray(item.orderNumbers)
    ? item.orderNumbers
        .filter(isNonEmptyString)
        .map((orderNumber) => orderNumber.trim())
    : [];

  if (orderNumbers.length === 0 || !isValidShipment(item.shipment, labelSize)) {
    return null;
  }

  return {
    shipment: item.shipment,
    orderNumbers,
  };
}

export function createShippingPostagesAction(
  dependencies: ShippingPostageActionDependencies = {},
) {
  const getConfig =
    dependencies.getShippingExportConfig ?? getShippingExportConfig;
  const purchaseFn =
    dependencies.purchaseShippingPostages ?? purchaseShippingPostages;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as Partial<ShippingPostagePurchaseRequest>;
      const labelSize = payload.labelSize;

      if (!labelSize || !LABEL_SIZES.has(labelSize)) {
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
        .map((item) => validateRequestItem(item, labelSize))
        .filter((item): item is ShippingPostagePurchaseRequestItem => item !== null);

      if (shipments.length !== payload.shipments.length) {
        return data(
          {
            error:
              "Each shipment must include a valid USPS shipment payload, matching label size, and one or more order numbers.",
          },
          { status: 400 },
        );
      }

      const config = await getConfig();
      const response = await purchaseFn(
        config.easypostMode,
        labelSize,
        shipments,
      );

      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
