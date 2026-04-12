import { data } from "react-router";
import { shippingPostagePurchasesRepository } from "~/core/db";
import type { ShippingPostagePurchaseRecord } from "~/core/db/repositories/shippingPostagePurchases.server";
import type {
  ShippingPostageLookupResult,
  ShippingPostageLookupRequest,
  ShippingPostageLookupRequestItem,
  ShippingPostageLookupResponse,
} from "../types/shippingExport";

type ShippingPostageLookupsActionDependencies = {
  postagePurchasesRepository?: Pick<
    typeof shippingPostagePurchasesRepository,
    "findLatestSuccessfulOutboundByOrderNumbers"
  >;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOrderNumbers(orderNumbers: string[]): string[] {
  return [...new Set(orderNumbers.map((orderNumber) => orderNumber.trim()).filter(Boolean))].sort();
}

function hasSameOrderNumbers(
  left: string[],
  right: string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function toOrderNumberKey(orderNumbers: string[]): string {
  return normalizeOrderNumbers(orderNumbers).join("|");
}

function validateRequestItem(
  value: unknown,
): ShippingPostageLookupRequestItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const item = value as Record<string, unknown>;
  const shipmentReference = isNonEmptyString(item.shipmentReference)
    ? item.shipmentReference.trim()
    : "";
  const orderNumbers = Array.isArray(item.orderNumbers)
    ? item.orderNumbers
        .filter(isNonEmptyString)
        .map((orderNumber) => orderNumber.trim())
    : [];

  if (!shipmentReference || orderNumbers.length === 0) {
    return null;
  }

  return {
    shipmentReference,
    orderNumbers,
  };
}

function findMatchingPurchaseRecord(
  recordsByExactOrderNumbers: Map<string, ShippingPostagePurchaseRecord>,
  records: ShippingPostagePurchaseRecord[],
  item: ShippingPostageLookupRequestItem,
): ShippingPostagePurchaseRecord | null {
  const normalizedOrderNumbers = normalizeOrderNumbers(item.orderNumbers);
  const exactMatch =
    recordsByExactOrderNumbers.get(toOrderNumberKey(normalizedOrderNumbers)) ?? null;

  if (exactMatch) {
    return exactMatch;
  }

  if (normalizedOrderNumbers.length !== 1) {
    return null;
  }

  const [orderNumber] = normalizedOrderNumbers;

  return (
    records.find((record) =>
      normalizeOrderNumbers(record.orderNumbers).includes(orderNumber),
    ) ?? null
  );
}

export function createShippingPostageLookupsAction(
  dependencies: ShippingPostageLookupsActionDependencies = {},
) {
  const repository =
    dependencies.postagePurchasesRepository ?? shippingPostagePurchasesRepository;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as Partial<ShippingPostageLookupRequest>;

      if (!Array.isArray(payload.shipments) || payload.shipments.length === 0) {
        return data(
          { error: "shipments must be a non-empty array." },
          { status: 400 },
        );
      }

      const shipments = payload.shipments
        .map(validateRequestItem)
        .filter((item): item is ShippingPostageLookupRequestItem => item !== null);

      if (shipments.length !== payload.shipments.length) {
        return data(
          {
            error:
              "Each shipment lookup must include a shipmentReference and one or more order numbers.",
          },
          { status: 400 },
        );
      }

      const allOrderNumbers = shipments.flatMap((shipment) => shipment.orderNumbers);
      const records =
        await repository.findLatestSuccessfulOutboundByOrderNumbers(allOrderNumbers);
      const recordsByExactOrderNumbers = new Map<string, ShippingPostagePurchaseRecord>();

      for (const record of records) {
        const exactKey = toOrderNumberKey(record.orderNumbers);

        if (!recordsByExactOrderNumbers.has(exactKey)) {
          recordsByExactOrderNumbers.set(exactKey, record);
        }
      }

      const results: ShippingPostageLookupResult[] = [];

      for (const shipment of shipments) {
        const match = findMatchingPurchaseRecord(
          recordsByExactOrderNumbers,
          records,
          shipment,
        );

        if (!match) {
          continue;
        }

        results.push({
          shipmentReference: shipment.shipmentReference,
          mode: match.mode,
          labelSize: match.labelSize,
          result: {
            reference: shipment.shipmentReference,
            orderNumbers: shipment.orderNumbers,
            status: "purchased",
            easypostShipmentId: match.easypostShipmentId ?? undefined,
            trackingCode: match.trackingCode ?? undefined,
            selectedRate:
              match.selectedRateService &&
              match.selectedRateRate &&
              match.selectedRateCurrency
                ? {
                    service: match.selectedRateService,
                    rate: match.selectedRateRate,
                    currency: match.selectedRateCurrency,
                  }
                : undefined,
            labelUrl: match.labelUrl ?? undefined,
            labelPdfUrl: match.labelPdfUrl ?? undefined,
          },
        });
      }

      const response: ShippingPostageLookupResponse = { results };

      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
