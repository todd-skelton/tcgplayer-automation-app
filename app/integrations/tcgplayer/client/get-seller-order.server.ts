import { orderManagementApi } from "~/core/clients";

export interface SellerOrderTax {
  code: string;
  amount: number;
}

export interface SellerOrderTransaction {
  productAmount: number;
  shippingAmount: number;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  directFeeAmount: number;
  taxes: SellerOrderTax[];
}

export interface SellerOrderShippingAddress {
  recipientName: string;
  addressOne: string;
  addressTwo?: string;
  city: string;
  territory: string;
  country: string;
  postalCode: string;
}

export interface SellerOrderProduct {
  name: string;
  unitPrice: number;
  extendedPrice: number;
  quantity: number;
  url: string;
  productId: string;
  skuId: string;
}

export interface SellerOrderDetail {
  createdAt: string;
  status: string;
  orderChannel: string;
  orderFulfillment: string;
  orderNumber: string;
  sellerName: string;
  buyerName: string;
  paymentType: string;
  pickupStatus: string;
  shippingType: string;
  estimatedDeliveryDate: string;
  transaction: SellerOrderTransaction;
  shippingAddress: SellerOrderShippingAddress;
  products: SellerOrderProduct[];
  refunds: unknown[];
  refundStatus: string;
  trackingNumbers: string[];
  allowedActions: string[];
}

export async function getSellerOrder(
  orderNumber: string,
): Promise<SellerOrderDetail> {
  return orderManagementApi.get<SellerOrderDetail>(
    `/orders/${encodeURIComponent(orderNumber)}?api-version=2.0`,
  );
}
