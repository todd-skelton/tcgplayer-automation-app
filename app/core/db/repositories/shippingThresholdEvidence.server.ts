import { allocatePurchasedPostage } from "~/features/inventory-economics/domain/postage";
import type { ShippedOrder, SnapPublication } from "~/core/types/shippingThresholds";
import { query, type Queryable } from "../database.server";

const CURRENCY = "USD";

export const shippingThresholdEvidenceRepository = {
  /** Orders placed since the given time that were not canceled, with their postage. */
  async findShippedOrders(sellerKey: string, since: Date, executor?: Queryable): Promise<ShippedOrder[]> {
    const orders = await query<{
      orderNumber: string; orderTime: Date; itemValue: number; buyerShipping: number | null;
      lines: Array<{ sku: string; quantity: number; value: number }>;
    }>(`SELECT orders.order_number AS "orderNumber",orders.order_time AS "orderTime",
        orders.gross_item_proceeds::float8 AS "itemValue",orders.gross_shipping_proceeds::float8 AS "buyerShipping",
        COALESCE((SELECT json_agg(json_build_object('sku',line.sku_id,'quantity',line.ordered_quantity,
          'value',line.gross_item_proceeds::float8)) FROM seller_order_lines line WHERE line.order_id=orders.id),'[]'::json) AS lines
      FROM seller_orders orders
      WHERE orders.seller_key=$1 AND orders.order_time>=$2 AND orders.lifecycle<>'canceled' AND orders.currency=$3
      ORDER BY orders.order_time,orders.order_number`, [sellerKey, since, CURRENCY], executor);
    if (orders.length === 0) return [];
    const postage = await query<{
      providerIdentity: string; orderNumbers: string[]; currency: string | null; rateCents: number | null;
      linkedSellers: string[]; linkedOrderCount: number;
    }>(`SELECT COALESCE(purchase.easypost_shipment_id,'row:'||purchase.id::text) AS "providerIdentity",
        purchase.order_numbers AS "orderNumbers",purchase.selected_rate_currency AS currency,
        CASE WHEN purchase.selected_rate_rate~'^[0-9]+([.][0-9]{1,2})?$'
          THEN ROUND(purchase.selected_rate_rate::numeric*100)::float8 END AS "rateCents",
        ARRAY(SELECT DISTINCT linked.seller_key FROM seller_orders linked WHERE linked.order_number=ANY(purchase.order_numbers)) AS "linkedSellers",
        (SELECT COUNT(*)::int FROM seller_orders linked WHERE linked.order_number=ANY(purchase.order_numbers)) AS "linkedOrderCount"
      FROM shipping_postage_purchases purchase
      WHERE purchase.mode='production' AND purchase.status='purchased' AND purchase.direction='outbound'
        AND purchase.order_numbers && $1::text[]
      ORDER BY purchase.created_at,purchase.id`, [orders.map((order) => order.orderNumber)], executor);
    const postageCents = allocatePurchasedPostage(sellerKey, CURRENCY, postage);
    return orders.map((order) => ({
      orderNumber: order.orderNumber,
      orderTime: order.orderTime,
      itemValue: order.itemValue,
      ...(order.buyerShipping === null ? {} : { buyerShipping: order.buyerShipping }),
      ...(postageCents.has(order.orderNumber) ? { postage: postageCents.get(order.orderNumber)! / 100 } : {}),
      lines: order.lines.flatMap((line) => {
        const sku = Number(line.sku);
        return Number.isSafeInteger(sku) && line.quantity > 0
          ? [{ sku, quantity: line.quantity, unitPrice: Math.round((line.value / line.quantity) * 100) / 100 }]
          : [];
      }),
    }));
  },

  /** Published prices since the given time whose decision considered a snap, oldest first. */
  async findSnapPublications(sellerKey: string, since: Date, executor?: Queryable): Promise<SnapPublication[]> {
    return query<SnapPublication>(`SELECT item.sku,item.published_at AS "publishedAt",
        item.desired_price::float8 AS "listedPrice",
        item.forecast_evidence->'decision'->'shippingThresholdSnap' AS snap
      FROM inventory_publication_items item
      JOIN inventory_publications publication ON publication.id=item.publication_id
      WHERE publication.seller_key=$1 AND item.status='published' AND item.published_at>=$2
        AND item.forecast_evidence->'decision' ? 'shippingThresholdSnap'
      ORDER BY item.published_at,item.id`, [sellerKey, since], executor);
  },
};
