export type SellerOrderLifecycle =
  | "processing"
  | "ready_to_ship"
  | "shipped_in_transit"
  | "shipped_delivered"
  | "completed_paid"
  | "canceled"
  | "unknown";

export type SellerOrderSource = "tcgplayer_api" | "file_import";

export interface SellerOrderLineEvidence {
  name: string;
  unitPrice: number;
  extendedPrice: number;
  quantity: number;
  productId: string;
  skuId: string;
}

export interface SellerOrderRefundEvidence {
  createdAt?: string;
  type?: string;
  amount?: number;
  origin?: string;
  shippingAmount?: number;
  products?: Array<{ amount?: number; productId?: string; skuId?: string }>;
}

export interface SellerOrderTransactionEvidence {
  productAmount: number;
  shippingAmount: number;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  directFeeAmount: number;
  taxes: Array<{ code: string; amount: number }>;
}

export interface SellerOrderObservation {
  sellerKey: string;
  orderNumber: string;
  orderTime: string;
  summaryOrderTime?: string;
  providerStatus: string;
  lifecycle: SellerOrderLifecycle;
  refundStatus?: string;
  orderChannel?: string;
  orderFulfillment?: string;
  grossItemProceeds: number;
  transaction?: SellerOrderTransactionEvidence;
  transactionCoverageReason?: string;
  lines: SellerOrderLineEvidence[];
  refunds: SellerOrderRefundEvidence[];
  source: SellerOrderSource;
  observedAt: string;
  fingerprint: string;
  summaryFingerprint?: string;
}

export interface SellerOrderCoverage {
  sellerKey: string;
  source: SellerOrderSource;
  status: "running" | "complete" | "incomplete" | "not_started";
  searchRange?: string;
  observedFrom?: string;
  observedThrough?: string;
  lastAttemptAt?: string;
  completedAt?: string;
  expectedTotal?: number;
  ordersObserved: number;
  detailsRecorded: number;
  nextOffset?: number;
  gaps: string[];
  error?: string;
}

export interface SellerOrderSyncResult {
  coverage: SellerOrderCoverage;
  changedOrderNumbers: string[];
}
