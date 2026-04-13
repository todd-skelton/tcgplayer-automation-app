import {
  getSellerOrder,
  type SellerOrderDetail,
} from "~/integrations/tcgplayer/client/get-seller-order.server";
import {
  searchSellerOrders,
  type SearchSellerOrdersResponse,
} from "~/integrations/tcgplayer/client/search-seller-orders.server";
import type {
  ShippingLiveOrderLoadResponse,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";

type SearchSellerOrdersFn = typeof searchSellerOrders;
type GetSellerOrderFn = typeof getSellerOrder;

const SEARCH_RANGE = "LastThreeMonths";
const ORDER_STATUSES = ["ReadyToShip"] as const;
const PAGE_SIZE = 500;
const READY_TO_SHIP_STATUS = "readytoship";
const SINGLE_ORDER_SEARCH_SIZE = 25;
const SINGLE_ORDER_SORT = [
  { sortingType: "orderStatus", direction: "ascending" },
  { sortingType: "orderDate", direction: "ascending" },
] as const;

function splitRecipientName(recipientName: string): {
  firstName: string;
  lastName: string;
} {
  const normalizedName = recipientName.trim().replace(/\s+/g, " ");

  if (!normalizedName) {
    return { firstName: "", lastName: "" };
  }

  const [firstName, ...lastNameParts] = normalizedName.split(" ");

  return {
    firstName,
    lastName: lastNameParts.join(" "),
  };
}

function sumProductQuantity(order: SellerOrderDetail): number {
  return order.products.reduce((total, product) => total + product.quantity, 0);
}

function normalizeOrderStatus(status: string): string {
  return status.trim().replace(/\s+/g, "").toLowerCase();
}

function getSingleOrderWarnings(order: SellerOrderDetail): string[] {
  const normalizedStatus = normalizeOrderStatus(order.status);

  if (normalizedStatus === READY_TO_SHIP_STATUS) {
    return [];
  }

  return [
    `Order ${order.orderNumber} is currently "${order.status}", not "Ready to Ship". Review it before buying postage.`,
  ];
}

export function mapSellerOrderDetailToShippingOrder(
  order: SellerOrderDetail,
): TcgPlayerShippingOrder {
  const { firstName, lastName } = splitRecipientName(
    order.shippingAddress.recipientName,
  );

  return {
    "Order #": order.orderNumber,
    FirstName: firstName,
    LastName: lastName,
    Address1: order.shippingAddress.addressOne?.trim() ?? "",
    Address2: order.shippingAddress.addressTwo?.trim() ?? "",
    City: order.shippingAddress.city?.trim() ?? "",
    State: order.shippingAddress.territory?.trim() ?? "",
    PostalCode: order.shippingAddress.postalCode?.trim() ?? "",
    Country: order.shippingAddress.country?.trim() || "US",
    "Order Date": order.createdAt,
    "Product Weight": 0,
    "Shipping Method": order.shippingType as TcgPlayerShippingOrder["Shipping Method"],
    "Item Count": sumProductQuantity(order),
    "Value Of Products": order.transaction.productAmount,
    "Shipping Fee Paid": order.transaction.shippingAmount,
    "Tracking #": "",
    Carrier: "",
  };
}

async function fetchAllSellerOrderSummaries(
  sellerKey: string,
  searchOrders: SearchSellerOrdersFn,
): Promise<SearchSellerOrdersResponse> {
  let from = 0;
  let totalOrders = 0;
  const orders: SearchSellerOrdersResponse["orders"] = [];

  do {
    const response = await searchOrders({
      searchRange: SEARCH_RANGE,
      filters: {
        sellerKey,
        orderStatuses: [...ORDER_STATUSES],
      },
      sortBy: [],
      from,
      size: PAGE_SIZE,
    });

    totalOrders = response.totalOrders;
    orders.push(...response.orders);
    from += PAGE_SIZE;
  } while (orders.length < totalOrders);

  return { totalOrders, orders };
}

async function fetchSingleSellerOrderSummary(
  sellerKey: string,
  orderNumber: string,
  searchOrders: SearchSellerOrdersFn,
) {
  const response = await searchOrders({
    searchRange: SEARCH_RANGE,
    query: {
      orderNumber,
    },
    filters: {
      sellerKey,
    },
    sortBy: [...SINGLE_ORDER_SORT],
    from: 0,
    size: SINGLE_ORDER_SEARCH_SIZE,
  });
  const match =
    response.orders.find((order) => order.orderNumber === orderNumber) ?? null;

  if (!match) {
    throw new Error(
      `Order ${orderNumber} was not found for seller ${sellerKey}.`,
    );
  }

  return match;
}

export async function loadSellerShippingOrders(
  sellerKey: string,
  dependencies: {
    searchOrders?: SearchSellerOrdersFn;
    getOrder?: GetSellerOrderFn;
  } = {},
): Promise<ShippingLiveOrderLoadResponse> {
  const searchOrders = dependencies.searchOrders ?? searchSellerOrders;
  const getOrder = dependencies.getOrder ?? getSellerOrder;
  const searchResponse = await fetchAllSellerOrderSummaries(sellerKey, searchOrders);
  const detailResults = await Promise.allSettled(
    searchResponse.orders.map((summary) => getOrder(summary.orderNumber)),
  );

  const orders: TcgPlayerShippingOrder[] = [];
  const loadedOrderNumbers: string[] = [];
  const warnings: string[] = [];

  detailResults.forEach((result, index) => {
    const orderNumber = searchResponse.orders[index]?.orderNumber ?? "unknown";

    if (result.status === "fulfilled") {
      loadedOrderNumbers.push(result.value.orderNumber);
      orders.push(mapSellerOrderDetailToShippingOrder(result.value));
      return;
    }

    warnings.push(
      `Failed to load seller order ${orderNumber}: ${String(result.reason)}`,
    );
  });

  return {
    sellerKey,
    totalOrders: searchResponse.totalOrders,
    loadedOrderNumbers,
    orders,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function loadSingleSellerShippingOrder(
  sellerKey: string,
  orderNumber: string,
  dependencies: {
    searchOrders?: SearchSellerOrdersFn;
    getOrder?: GetSellerOrderFn;
  } = {},
): Promise<ShippingLiveOrderLoadResponse> {
  const searchOrders = dependencies.searchOrders ?? searchSellerOrders;
  const getOrder = dependencies.getOrder ?? getSellerOrder;
  const normalizedOrderNumber = orderNumber.trim();
  const normalizedSellerKey = sellerKey.trim();
  const summary = await fetchSingleSellerOrderSummary(
    normalizedSellerKey,
    normalizedOrderNumber,
    searchOrders,
  );
  const order = await getOrder(summary.orderNumber);
  const warnings = getSingleOrderWarnings(order);

  return {
    sellerKey: normalizedSellerKey,
    totalOrders: 1,
    loadedOrderNumbers: [order.orderNumber],
    orders: [mapSellerOrderDetailToShippingOrder(order)],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
