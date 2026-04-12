export type LabelSize = "4x6" | "7x3" | "6x4";
export type LabelFormat = "PDF" | "PNG";
export type EasyPostMode = "test" | "production";
export type ShippingPostageDirection = "outbound" | "return";
export type ShippingPostagePurchaseScope = "bulk" | "single";

export type EasyPostPackageType = "Letter" | "Flat" | "Parcel";
export type EasyPostService =
  | "First"
  | "GroundAdvantage"
  | "Priority"
  | "Express";
export type DeliveryConfirmation = "NO_SIGNATURE" | "SIGNATURE";

export interface EasyPostAddress {
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface EasyPostParcel {
  length: number;
  width: number;
  height: number;
  weight: number;
  predefined_package: EasyPostPackageType;
}

export interface EasyPostShipment {
  reference: string;
  to_address: EasyPostAddress;
  from_address: EasyPostAddress;
  return_address: EasyPostAddress;
  parcel: EasyPostParcel;
  carrier: "USPS";
  service: EasyPostService;
  options: {
    label_format: LabelFormat;
    label_size: LabelSize;
    invoice_number: string;
    delivery_confirmation: DeliveryConfirmation;
  };
}

export type TcgPlayerShippingMethod = `Standard${string}` | `Expedited${string}`;

export interface TcgPlayerShippingOrder {
  "Order #": string;
  FirstName: string;
  LastName: string;
  Address1: string;
  Address2: string;
  City: string;
  State: string;
  PostalCode: string | number;
  Country: string;
  "Order Date": string;
  "Product Weight": number;
  "Shipping Method": TcgPlayerShippingMethod;
  "Item Count": number;
  "Value Of Products": number;
  "Shipping Fee Paid": number;
  "Tracking #": string;
  Carrier: string;
}

export interface ShippingPackageSettings {
  labelSize: LabelSize;
  baseWeightOz: number;
  perItemWeightOz: number;
  maxItemCount?: number;
  maxValueUsd?: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface ShippingExportConfig {
  defaultSellerKey: string;
  fromAddress: EasyPostAddress;
  letter: ShippingPackageSettings;
  flat: ShippingPackageSettings;
  parcel: ShippingPackageSettings;
  labelFormat: LabelFormat;
  combineOrders: boolean;
  expeditedService: EasyPostService;
  easypostMode: EasyPostMode;
}

export type ShipmentToOrderMap = Record<string, string[]>;

export interface ShippingPostagePurchaseRequestItem {
  shipment: EasyPostShipment;
  orderNumbers: string[];
}

export interface ShippingPostagePurchaseRequest {
  labelSize: LabelSize;
  direction?: ShippingPostageDirection;
  purchaseScope?: ShippingPostagePurchaseScope;
  shipments: ShippingPostagePurchaseRequestItem[];
}

export interface ShippingPostageLookupRequestItem {
  shipmentReference: string;
  orderNumbers: string[];
}

export interface ShippingPostageLookupRequest {
  shipments: ShippingPostageLookupRequestItem[];
}

export interface ShippingPostageRateSummary {
  service: string;
  rate: string;
  currency: string;
}

export type ShippingPostagePurchaseStatus =
  | "purchased"
  | "failed"
  | "skipped";

export type ShippingPostageBatchLabelStatus =
  | "ready"
  | "pending"
  | "failed"
  | "skipped";

export interface ShippingPostagePurchaseResult {
  reference: string;
  orderNumbers: string[];
  status: ShippingPostagePurchaseStatus;
  easypostShipmentId?: string;
  trackingCode?: string;
  selectedRate?: ShippingPostageRateSummary;
  labelUrl?: string;
  labelPdfUrl?: string;
  error?: string;
}

export interface ShippingPostageBatchLabelResult {
  status: ShippingPostageBatchLabelStatus;
  shipmentReferences: string[];
  batchId?: string;
  labelUrl?: string;
  message?: string;
}

export interface ShippingPostagePurchaseResponse {
  mode: EasyPostMode;
  batchLabel: ShippingPostageBatchLabelResult;
  results: ShippingPostagePurchaseResult[];
}

export interface ShippingTrackingApplyRequestItem {
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
}

export interface ShippingTrackingApplyRequest {
  updates: ShippingTrackingApplyRequestItem[];
}

export type ShippingTrackingApplyStatus = "applied" | "failed";

export interface ShippingTrackingApplyResult {
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  status: ShippingTrackingApplyStatus;
  error?: string;
}

export interface ShippingTrackingApplyResponse {
  results: ShippingTrackingApplyResult[];
}

export interface ShippingShippedMessageRequestItem {
  orderNumber: string;
  sellerKey: string;
  easypostShipmentId: string;
}

export interface ShippingShippedMessageRequest {
  messages: ShippingShippedMessageRequestItem[];
}

export type ShippingShippedMessageStatus = "sent" | "failed";

export interface ShippingShippedMessageResult {
  orderNumber: string;
  sellerKey: string;
  easypostShipmentId: string;
  trackingUrl?: string;
  status: ShippingShippedMessageStatus;
  error?: string;
}

export interface ShippingShippedMessageResponse {
  results: ShippingShippedMessageResult[];
}

export interface ShippingPostageLookupResult {
  shipmentReference: string;
  mode: EasyPostMode;
  labelSize: LabelSize;
  result: ShippingPostagePurchaseResult;
}

export interface ShippingPostageLookupResponse {
  results: ShippingPostageLookupResult[];
}

export interface ShippingLiveOrderLoadResponse {
  sellerKey: string;
  totalOrders: number;
  loadedOrderNumbers: string[];
  orders: TcgPlayerShippingOrder[];
  warnings?: string[];
}

export interface ShippingPostageBatchLabelRequestItem {
  shipmentReference: string;
  easypostShipmentId: string;
}

export interface ShippingPostageBatchLabelRequest {
  mode: EasyPostMode;
  labelSize: LabelSize;
  shipments: ShippingPostageBatchLabelRequestItem[];
}

export interface EasyPostEnvironmentStatus {
  hasTestApiKey: boolean;
  hasProductionApiKey: boolean;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const SLEEVED_CARD_OZ = 0.09;
const NO_10_ENVELOPE_OZ = 0.2;
const TEAM_BAG_OZ = 0.03;
const PACKING_SLIP_OZ = 0.08;
const BUBBLE_MAILER_5X7_OZ = 0.3;
const BUBBLE_MAILER_7X9_OZ = 0.45;
const RACK_CARD_OZ = 0.18;
const BINDER_PAGE_OZ = 0.14;
const LETTER_PAPER_OZ = 0.2;

const DEFAULT_FROM_ADDRESS: EasyPostAddress = {
  name: "",
  street1: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
};

const DEFAULT_LETTER_BASE_WEIGHT_OZ =
  NO_10_ENVELOPE_OZ + RACK_CARD_OZ + BINDER_PAGE_OZ + PACKING_SLIP_OZ;
const DEFAULT_FLAT_BASE_WEIGHT_OZ =
  BUBBLE_MAILER_5X7_OZ + TEAM_BAG_OZ * 2 + PACKING_SLIP_OZ;
const DEFAULT_PARCEL_BASE_WEIGHT_OZ =
  BUBBLE_MAILER_7X9_OZ + TEAM_BAG_OZ * 4 + LETTER_PAPER_OZ + PACKING_SLIP_OZ;

export const DEFAULT_SHIPPING_EXPORT_CONFIG: ShippingExportConfig = {
  defaultSellerKey: "",
  fromAddress: DEFAULT_FROM_ADDRESS,
  letter: {
    labelSize: "7x3",
    baseWeightOz: DEFAULT_LETTER_BASE_WEIGHT_OZ,
    perItemWeightOz: SLEEVED_CARD_OZ,
    maxItemCount: 24,
    maxValueUsd: 50,
    lengthIn: 9.5,
    widthIn: 4.125,
    heightIn: 0.25,
  },
  flat: {
    labelSize: "4x6",
    baseWeightOz: DEFAULT_FLAT_BASE_WEIGHT_OZ,
    perItemWeightOz: SLEEVED_CARD_OZ,
    maxItemCount: 100,
    maxValueUsd: 50,
    lengthIn: 5,
    widthIn: 7,
    heightIn: 0.75,
  },
  parcel: {
    labelSize: "4x6",
    baseWeightOz: DEFAULT_PARCEL_BASE_WEIGHT_OZ,
    perItemWeightOz: SLEEVED_CARD_OZ,
    lengthIn: 7,
    widthIn: 9,
    heightIn: 0.75,
  },
  labelFormat: "PDF",
  combineOrders: true,
  expeditedService: "GroundAdvantage",
  easypostMode: "test",
};

export function mergeShippingExportConfigWithDefaults(
  config?: DeepPartial<ShippingExportConfig> | null,
): ShippingExportConfig {
  const value = config ?? {};

  return {
    ...DEFAULT_SHIPPING_EXPORT_CONFIG,
    ...value,
    fromAddress: {
      ...DEFAULT_SHIPPING_EXPORT_CONFIG.fromAddress,
      ...(value.fromAddress ?? {}),
    },
    letter: {
      ...DEFAULT_SHIPPING_EXPORT_CONFIG.letter,
      ...(value.letter ?? {}),
    },
    flat: {
      ...DEFAULT_SHIPPING_EXPORT_CONFIG.flat,
      ...(value.flat ?? {}),
    },
    parcel: {
      ...DEFAULT_SHIPPING_EXPORT_CONFIG.parcel,
      ...(value.parcel ?? {}),
    },
  };
}
