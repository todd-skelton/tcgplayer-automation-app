import { createSellerOrderMessageThread } from "~/integrations/tcgplayer/client/create-seller-order-message-thread.server";
import { getPublicTrackingUrlForPurchasedShipment } from "./easyPostPostage.server";
import type {
  ShippingShippedMessageRequestItem,
  ShippingShippedMessageResponse,
  ShippingShippedMessageResult,
} from "../types/shippingExport";

type CreateSellerOrderMessageThreadFn = typeof createSellerOrderMessageThread;
type GetPublicTrackingUrlForPurchasedShipmentFn =
  typeof getPublicTrackingUrlForPurchasedShipment;

const SHIPPED_MESSAGE_SUBJECT_ID = "2";
const SHIPPED_MESSAGE_ASSOCIATION_TYPE = "SellerOrder";
const STORE_NAME = "Pok\u00E9Bash TCG";
const SUPPORT_SIGNATURE = "Pok\u00E9Bash TCG Support Team";

function normalizeShippedMessageRequests(
  messages: ShippingShippedMessageRequestItem[],
): ShippingShippedMessageRequestItem[] {
  const seenOrderNumbers = new Set<string>();

  return messages
    .map((message) => ({
      orderNumber: message.orderNumber.trim(),
      sellerKey: message.sellerKey.trim(),
      easypostShipmentId: message.easypostShipmentId.trim(),
    }))
    .filter((message) => {
      if (
        !message.orderNumber ||
        !message.sellerKey ||
        !message.easypostShipmentId ||
        seenOrderNumbers.has(message.orderNumber)
      ) {
        return false;
      }

      seenOrderNumbers.add(message.orderNumber);
      return true;
    });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildShippedMessageBody(trackingUrl: string): string {
  const safeTrackingUrl = escapeHtmlAttribute(trackingUrl);

  return [
    "<b>TLDR: Your order has shipped! Use the tracking link below for updates, and please reply if you have any questions or issues. Your satisfaction is guaranteed.</b>",
    "",
    "Greetings,",
    "",
    "Great news \u2014 your order is on its way! We\u2019re excited to get your cards into your hands.",
    "",
    "You can track your shipment here:",
    "",
    `<a href=${safeTrackingUrl} target=_blank>${STORE_NAME} Tracking</a>`,
    "",
    "Please keep in mind that it can take 24\u201348 hours for the first scan to appear, so a short delay in updates is completely normal.",
    "",
    "If your order has not arrived within a week of shipping, please reply to this message and we\u2019ll gladly look into it for you.",
    "",
    "We\u2019re committed to your satisfaction with a 100% satisfaction guarantee. If anything about your order is not as expected, including card condition or delivery concerns, please contact us right away and we\u2019ll work to make it right.",
    "",
    "Your feedback means a lot to us. Once your order arrives, we\u2019d greatly appreciate it if you took a moment to leave a review of your purchase.",
    "",
    `Thank you again for choosing ${STORE_NAME}. We hope you love your new cards!`,
    "",
    "Warm regards,",
    SUPPORT_SIGNATURE,
  ].join("\n");
}

export async function sendShippedMessagesToSellerOrders(
  messages: ShippingShippedMessageRequestItem[],
  dependencies: {
    createThread?: CreateSellerOrderMessageThreadFn;
    getTrackingUrl?: GetPublicTrackingUrlForPurchasedShipmentFn;
  } = {},
): Promise<ShippingShippedMessageResponse> {
  const createThread =
    dependencies.createThread ?? createSellerOrderMessageThread;
  const getTrackingUrl =
    dependencies.getTrackingUrl ?? getPublicTrackingUrlForPurchasedShipment;
  const normalizedMessages = normalizeShippedMessageRequests(messages);
  const trackingUrlByShipmentId = new Map<string, Promise<string>>();

  const results = await Promise.all(
    normalizedMessages.map(async (message) => {
      try {
        let trackingUrlPromise = trackingUrlByShipmentId.get(
          message.easypostShipmentId,
        );

        if (!trackingUrlPromise) {
          trackingUrlPromise = getTrackingUrl(
            "production",
            message.easypostShipmentId,
          );
          trackingUrlByShipmentId.set(
            message.easypostShipmentId,
            trackingUrlPromise,
          );
        }

        const trackingUrl = await trackingUrlPromise;

        await createThread({
          sellerKey: message.sellerKey,
          subjectId: SHIPPED_MESSAGE_SUBJECT_ID,
          messageBody: buildShippedMessageBody(trackingUrl),
          associationType: SHIPPED_MESSAGE_ASSOCIATION_TYPE,
          associationValue: message.orderNumber,
        });

        const result: ShippingShippedMessageResult = {
          orderNumber: message.orderNumber,
          sellerKey: message.sellerKey,
          easypostShipmentId: message.easypostShipmentId,
          trackingUrl,
          status: "sent",
        };

        return result;
      } catch (error) {
        const result: ShippingShippedMessageResult = {
          orderNumber: message.orderNumber,
          sellerKey: message.sellerKey,
          easypostShipmentId: message.easypostShipmentId,
          status: "failed",
          error: String(error),
        };

        return result;
      }
    }),
  );

  return { results };
}
