import {
  type DeliveryConfirmation,
  type EasyPostAddress,
  type EasyPostPackageType,
  type EasyPostService,
  type EasyPostShipment,
  type ShipmentToOrderMap,
  type ShippingExportConfig,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";

const LABEL_SIZES = ["4x6", "7x3", "6x4"] as const;

function getOrderDateTimestamp(order: TcgPlayerShippingOrder): number | null {
  const timestamp = Date.parse(order["Order Date"]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortShippingOrdersByOldestFirst(
  orders: TcgPlayerShippingOrder[],
): TcgPlayerShippingOrder[] {
  return orders
    .map((order, index) => ({
      index,
      order,
      timestamp: getOrderDateTimestamp(order),
    }))
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null) {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp - right.timestamp;
        }
      }

      return left.index - right.index;
    })
    .map((entry) => entry.order);
}

export function getOrderNumbersForShipmentReference(
  shipmentToOrderMap: ShipmentToOrderMap,
  shipmentReference: string,
): string[] {
  return shipmentToOrderMap[shipmentReference] ?? [shipmentReference];
}

export function buildOrderNumbersInShipmentOrder(
  shipmentReferences: string[],
  shipmentToOrderMap: ShipmentToOrderMap,
): string[] {
  const orderedOrderNumbers: string[] = [];
  const seenOrderNumbers = new Set<string>();

  for (const shipmentReference of shipmentReferences) {
    for (const orderNumber of getOrderNumbersForShipmentReference(
      shipmentToOrderMap,
      shipmentReference,
    )) {
      const normalizedOrderNumber = orderNumber.trim();

      if (!normalizedOrderNumber || seenOrderNumbers.has(normalizedOrderNumber)) {
        continue;
      }

      seenOrderNumbers.add(normalizedOrderNumber);
      orderedOrderNumbers.push(normalizedOrderNumber);
    }
  }

  return orderedOrderNumbers;
}

export interface ShippingWorkflowOrderState {
  sourceOrders: TcgPlayerShippingOrder[];
  orders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  shipmentToOrderMap: ShipmentToOrderMap;
  shipmentReferences: string[];
  orderedOrderNumbers: string[];
}

export function normalizeZipCode(zipCode: string | number): string {
  const digits = String(zipCode ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length <= 5) {
    return digits.padStart(5, "0");
  }

  const paddedDigits = digits.slice(0, 9).padEnd(9, "0");
  return `${paddedDigits.slice(0, 5)}-${paddedDigits.slice(5)}`;
}

export function mergeOrdersByAddress(
  orders: TcgPlayerShippingOrder[],
  combineOrders: boolean,
): { orders: TcgPlayerShippingOrder[]; shipmentToOrderMap: ShipmentToOrderMap } {
  if (!combineOrders) {
    return {
      orders,
      shipmentToOrderMap: Object.fromEntries(
        orders.map((order) => [order["Order #"], [order["Order #"]]]),
      ),
    };
  }

  const shipmentToOrderMap: ShipmentToOrderMap = {};
  const processedOrderNumbers = new Set<string>();
  const mergedOrders = orders.reduce<Record<string, TcgPlayerShippingOrder>>(
    (accumulator, order) => {
      if (processedOrderNumbers.has(order["Order #"])) {
        return accumulator;
      }

      const addressKey = [
        order.Address1,
        order.Address2,
        order.City,
        order.State,
        normalizeZipCode(order.PostalCode),
        order.Country,
      ].join("|");

      if (!accumulator[addressKey]) {
        accumulator[addressKey] = { ...order };
        shipmentToOrderMap[order["Order #"]] = [order["Order #"]];
      } else {
        const primaryOrderNumber = accumulator[addressKey]["Order #"];
        shipmentToOrderMap[primaryOrderNumber] = [
          ...(shipmentToOrderMap[primaryOrderNumber] ?? [primaryOrderNumber]),
          order["Order #"],
        ];
        accumulator[addressKey]["Item Count"] += order["Item Count"];
        accumulator[addressKey]["Value Of Products"] +=
          order["Value Of Products"];

        if (order["Shipping Method"].startsWith("Expedited")) {
          accumulator[addressKey]["Shipping Method"] = order["Shipping Method"];
        }
      }

      processedOrderNumbers.add(order["Order #"]);
      return accumulator;
    },
    {},
  );

  return {
    orders: Object.values(mergedOrders),
    shipmentToOrderMap,
  };
}

export function buildShippingWorkflowOrderState(
  sourceOrders: TcgPlayerShippingOrder[],
  config: ShippingExportConfig,
): ShippingWorkflowOrderState {
  const orderedSourceOrders = sortShippingOrdersByOldestFirst(sourceOrders);
  const mergedOrders = mergeOrdersByAddress(
    orderedSourceOrders,
    config.combineOrders,
  );
  const shipments = mapOrdersToShipments(mergedOrders.orders, config);
  const shipmentReferences = shipments.map((shipment) => shipment.reference);

  return {
    sourceOrders: orderedSourceOrders,
    orders: mergedOrders.orders,
    shipments,
    shipmentToOrderMap: mergedOrders.shipmentToOrderMap,
    shipmentReferences,
    orderedOrderNumbers: buildOrderNumbersInShipmentOrder(
      shipmentReferences,
      mergedOrders.shipmentToOrderMap,
    ),
  };
}

export function calculateService(
  order: TcgPlayerShippingOrder,
  config: ShippingExportConfig,
): EasyPostService {
  if (order["Shipping Method"].startsWith("Expedited")) {
    return config.expeditedService;
  }

  if (
    config.flat.maxValueUsd !== undefined &&
    order["Value Of Products"] >= config.flat.maxValueUsd
  ) {
    return "GroundAdvantage";
  }

  if (
    config.flat.maxItemCount !== undefined &&
    order["Item Count"] > config.flat.maxItemCount
  ) {
    return "GroundAdvantage";
  }

  return "First";
}

export function calculatePackageType(
  order: TcgPlayerShippingOrder,
  config: ShippingExportConfig,
): EasyPostPackageType {
  if (
    config.flat.maxItemCount !== undefined &&
    order["Item Count"] > config.flat.maxItemCount
  ) {
    return "Parcel";
  }

  if (order["Shipping Method"].startsWith("Expedited")) {
    return "Parcel";
  }

  if (
    config.flat.maxValueUsd !== undefined &&
    order["Value Of Products"] >= config.flat.maxValueUsd
  ) {
    return "Parcel";
  }

  if (
    config.letter.maxItemCount !== undefined &&
    order["Item Count"] > config.letter.maxItemCount
  ) {
    return "Flat";
  }

  return "Letter";
}

export function getDeliveryConfirmation(
  orderValue: number,
): DeliveryConfirmation {
  return orderValue >= 250 ? "SIGNATURE" : "NO_SIGNATURE";
}

export function mapOrderToAddress(
  order: TcgPlayerShippingOrder,
): EasyPostAddress {
  return {
    name: `${order.FirstName} ${order.LastName}`.trim(),
    street1: order.Address1,
    street2: order.Address2 || undefined,
    city: order.City,
    state: order.State,
    zip: normalizeZipCode(order.PostalCode),
    country: order.Country || "US",
  };
}

export function mapOrderToShipment(
  order: TcgPlayerShippingOrder,
  config: ShippingExportConfig,
): EasyPostShipment {
  const service = calculateService(order, config);
  const packageType = calculatePackageType(order, config);
  const packageSettings =
    packageType === "Letter"
      ? config.letter
      : packageType === "Flat"
        ? config.flat
        : config.parcel;

  return {
    reference: order["Order #"],
    to_address: mapOrderToAddress(order),
    from_address: { ...config.fromAddress },
    return_address: { ...config.fromAddress },
    parcel: {
      length: packageSettings.lengthIn,
      width: packageSettings.widthIn,
      height: packageSettings.heightIn,
      weight:
        Math.ceil(
          (packageSettings.baseWeightOz +
            order["Item Count"] * packageSettings.perItemWeightOz) *
            100,
        ) / 100,
      predefined_package: packageType,
    },
    carrier: "USPS",
    service,
    options: {
      label_format: config.labelFormat,
      label_size: packageSettings.labelSize,
      invoice_number: order["Order #"],
      delivery_confirmation: getDeliveryConfirmation(
        order["Value Of Products"],
      ),
    },
  };
}

export function mapOrdersToShipments(
  orders: TcgPlayerShippingOrder[],
  config: ShippingExportConfig,
): EasyPostShipment[] {
  return orders.map((order) => mapOrderToShipment(order, config));
}

export function createReturnShipment(
  shipment: EasyPostShipment,
): EasyPostShipment {
  return {
    ...shipment,
    to_address: { ...shipment.from_address },
    from_address: { ...shipment.to_address },
  };
}

export function getShipmentsForLabelSize(
  shipments: EasyPostShipment[],
  labelSize: string,
): EasyPostShipment[] {
  return shipments.filter((shipment) => shipment.options.label_size === labelSize);
}

export function flattenShipmentForCsv(
  shipment: EasyPostShipment,
): Record<string, number | string> {
  return {
    reference: shipment.reference,
    "to_address.name": shipment.to_address.name,
    "to_address.company": shipment.to_address.company ?? "",
    "to_address.phone": shipment.to_address.phone ?? "",
    "to_address.email": shipment.to_address.email ?? "",
    "to_address.street1": shipment.to_address.street1,
    "to_address.street2": shipment.to_address.street2 ?? "",
    "to_address.city": shipment.to_address.city,
    "to_address.state": shipment.to_address.state,
    "to_address.zip": shipment.to_address.zip,
    "to_address.country": shipment.to_address.country,
    "from_address.name": shipment.from_address.name,
    "from_address.company": shipment.from_address.company ?? "",
    "from_address.phone": shipment.from_address.phone ?? "",
    "from_address.email": shipment.from_address.email ?? "",
    "from_address.street1": shipment.from_address.street1,
    "from_address.street2": shipment.from_address.street2 ?? "",
    "from_address.city": shipment.from_address.city,
    "from_address.state": shipment.from_address.state,
    "from_address.zip": shipment.from_address.zip,
    "from_address.country": shipment.from_address.country,
    "return_address.name": shipment.return_address.name,
    "return_address.company": shipment.return_address.company ?? "",
    "return_address.phone": shipment.return_address.phone ?? "",
    "return_address.email": shipment.return_address.email ?? "",
    "return_address.street1": shipment.return_address.street1,
    "return_address.street2": shipment.return_address.street2 ?? "",
    "return_address.city": shipment.return_address.city,
    "return_address.state": shipment.return_address.state,
    "return_address.zip": shipment.return_address.zip,
    "return_address.country": shipment.return_address.country,
    "parcel.length": shipment.parcel.length,
    "parcel.width": shipment.parcel.width,
    "parcel.height": shipment.parcel.height,
    "parcel.weight": shipment.parcel.weight,
    "parcel.predefined_package": shipment.parcel.predefined_package,
    carrier: shipment.carrier,
    service: shipment.service,
    "options.label_format": shipment.options.label_format,
    "options.label_size": shipment.options.label_size,
    "options.invoice_number": shipment.options.invoice_number,
    "options.delivery_confirmation": shipment.options.delivery_confirmation,
  };
}

export function getShipmentCsvRows(
  shipments: EasyPostShipment[],
): Array<Record<string, number | string>> {
  return shipments.map(flattenShipmentForCsv);
}

export function buildTimestampedFileName(
  prefix: string,
  now = new Date(),
): string {
  return `${prefix}_${now.toISOString().replace(/[:T-]/g, ".").replace(/\..+$/, "")}.csv`;
}

export function getAllLabelSizes(): readonly string[] {
  return LABEL_SIZES;
}

