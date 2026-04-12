import { orderManagementApi } from "~/core/clients";

export type SellerOrderSearchRange = "LastThreeMonths";
export type SellerOrderStatusFilter = "ReadyToShip";

export interface SearchSellerOrdersRequest {
  searchRange: SellerOrderSearchRange;
  filters: {
    sellerKey: string;
    orderStatuses: SellerOrderStatusFilter[];
  };
  sortBy: unknown[];
  from: number;
  size: number;
}

export interface SellerOrderSearchSummary {
  orderNumber: string;
  orderDate: string;
  orderChannel: string;
  orderStatus: string;
  buyerName: string;
  shippingType: string;
  productAmount: number;
  shippingAmount: number;
  totalAmount: number;
  buyerPaid: boolean;
  orderFulfillment: string;
}

export interface SearchSellerOrdersResponse {
  totalOrders: number;
  orders: SellerOrderSearchSummary[];
}

export async function searchSellerOrders(
  request: SearchSellerOrdersRequest,
): Promise<SearchSellerOrdersResponse> {
  return orderManagementApi.post<SearchSellerOrdersResponse>(
    "/orders/search?api-version=2.0",
    request,
  );
}
