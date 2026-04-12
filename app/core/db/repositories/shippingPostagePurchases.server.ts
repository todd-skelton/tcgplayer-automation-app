import { execute, query, type Queryable } from "../database.server";
import type {
  EasyPostMode,
  LabelSize,
  ShippingPostageDirection,
  ShippingPostagePurchaseStatus,
} from "~/features/shipping-export/types/shippingExport";

export interface ShippingPostagePurchaseRecord {
  id: number;
  shipmentReference: string;
  orderNumbers: string[];
  mode: EasyPostMode;
  direction: ShippingPostageDirection;
  labelSize: LabelSize;
  easypostShipmentId: string | null;
  trackingCode: string | null;
  selectedRateService: string | null;
  selectedRateRate: string | null;
  selectedRateCurrency: string | null;
  labelUrl: string | null;
  labelPdfUrl: string | null;
  status: ShippingPostagePurchaseStatus;
  errorMessage: string | null;
  createdAt: Date;
}

export interface CreateShippingPostagePurchaseInput {
  shipmentReference: string;
  orderNumbers: string[];
  mode: EasyPostMode;
  direction?: ShippingPostageDirection;
  labelSize: LabelSize;
  easypostShipmentId?: string | null;
  trackingCode?: string | null;
  selectedRateService?: string | null;
  selectedRateRate?: string | null;
  selectedRateCurrency?: string | null;
  labelUrl?: string | null;
  labelPdfUrl?: string | null;
  status: ShippingPostagePurchaseStatus;
  errorMessage?: string | null;
}

export const shippingPostagePurchasesRepository = {
  async findLatestSuccessfulOutboundByOrderNumbers(
    orderNumbers: string[],
    executor?: Queryable,
  ): Promise<ShippingPostagePurchaseRecord[]> {
    const normalizedOrderNumbers = orderNumbers
      .map((orderNumber) => orderNumber.trim())
      .filter(Boolean);

    if (normalizedOrderNumbers.length === 0) {
      return [];
    }

    return query<ShippingPostagePurchaseRecord>(
      `SELECT
        id,
        shipment_reference AS "shipmentReference",
        order_numbers AS "orderNumbers",
        mode,
        direction,
        label_size AS "labelSize",
        easypost_shipment_id AS "easypostShipmentId",
        tracking_code AS "trackingCode",
        selected_rate_service AS "selectedRateService",
        selected_rate_rate AS "selectedRateRate",
        selected_rate_currency AS "selectedRateCurrency",
        label_url AS "labelUrl",
        label_pdf_url AS "labelPdfUrl",
        status,
        error_message AS "errorMessage",
        created_at AS "createdAt"
      FROM shipping_postage_purchases
      WHERE direction = 'outbound'
        AND status = 'purchased'
        AND order_numbers && $1::text[]
      ORDER BY created_at DESC, id DESC`,
      [normalizedOrderNumbers],
      executor,
    );
  },

  async findSuccessfulOutboundByOrderNumbers(
    mode: EasyPostMode,
    orderNumbers: string[],
    executor?: Queryable,
  ): Promise<ShippingPostagePurchaseRecord[]> {
    const normalizedOrderNumbers = orderNumbers
      .map((orderNumber) => orderNumber.trim())
      .filter(Boolean);

    if (normalizedOrderNumbers.length === 0) {
      return [];
    }

    return query<ShippingPostagePurchaseRecord>(
      `SELECT
        id,
        shipment_reference AS "shipmentReference",
        order_numbers AS "orderNumbers",
        mode,
        direction,
        label_size AS "labelSize",
        easypost_shipment_id AS "easypostShipmentId",
        tracking_code AS "trackingCode",
        selected_rate_service AS "selectedRateService",
        selected_rate_rate AS "selectedRateRate",
        selected_rate_currency AS "selectedRateCurrency",
        label_url AS "labelUrl",
        label_pdf_url AS "labelPdfUrl",
        status,
        error_message AS "errorMessage",
        created_at AS "createdAt"
      FROM shipping_postage_purchases
      WHERE mode = $1
        AND direction = 'outbound'
        AND status = 'purchased'
        AND order_numbers && $2::text[]`,
      [mode, normalizedOrderNumbers],
      executor,
    );
  },

  async create(
    input: CreateShippingPostagePurchaseInput,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO shipping_postage_purchases (
        shipment_reference,
        order_numbers,
        mode,
        direction,
        label_size,
        easypost_shipment_id,
        tracking_code,
        selected_rate_service,
        selected_rate_rate,
        selected_rate_currency,
        label_url,
        label_pdf_url,
        status,
        error_message
      ) VALUES (
        $1,
        $2::text[],
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14
      )`,
      [
        input.shipmentReference,
        input.orderNumbers,
        input.mode,
        input.direction ?? "outbound",
        input.labelSize,
        input.easypostShipmentId ?? null,
        input.trackingCode ?? null,
        input.selectedRateService ?? null,
        input.selectedRateRate ?? null,
        input.selectedRateCurrency ?? null,
        input.labelUrl ?? null,
        input.labelPdfUrl ?? null,
        input.status,
        input.errorMessage ?? null,
      ],
      executor,
    );
  },
};
