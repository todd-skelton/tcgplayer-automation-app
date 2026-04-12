import { orderManagementApi } from "~/core/clients";

export interface ApplyOrderTrackingRequest {
  carrier: string;
  trackingNumber: string;
}

export async function applyOrderTracking(
  orderNumber: string,
  request: ApplyOrderTrackingRequest,
): Promise<void> {
  await orderManagementApi.post<void, ApplyOrderTrackingRequest>(
    `/orders/${encodeURIComponent(orderNumber)}/tracking?api-version=2.0`,
    request,
  );
}
