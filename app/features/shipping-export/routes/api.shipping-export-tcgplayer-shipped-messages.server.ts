import { data } from "react-router";
import { sendShippedMessagesToSellerOrders } from "../services/tcgplayerShippedMessages.server";
import type {
  ShippingShippedMessageRequest,
  ShippingShippedMessageRequestItem,
} from "../types/shippingExport";

type ShippingTcgplayerShippedMessagesActionDependencies = {
  sendShippedMessagesToSellerOrders?: typeof sendShippedMessagesToSellerOrders;
};

function isValidShippedMessageItem(
  value: unknown,
): value is ShippingShippedMessageRequestItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Record<string, unknown>;

  return (
    typeof message.orderNumber === "string" &&
    message.orderNumber.trim().length > 0 &&
    typeof message.sellerKey === "string" &&
    message.sellerKey.trim().length > 0 &&
    typeof message.easypostShipmentId === "string" &&
    message.easypostShipmentId.trim().length > 0
  );
}

export function createShippingTcgplayerShippedMessagesAction(
  dependencies: ShippingTcgplayerShippedMessagesActionDependencies = {},
) {
  const sendMessages =
    dependencies.sendShippedMessagesToSellerOrders ??
    sendShippedMessagesToSellerOrders;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload =
        (await request.json()) as Partial<ShippingShippedMessageRequest>;

      if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        return data(
          { error: "messages must be a non-empty array." },
          { status: 400 },
        );
      }

      const messages = payload.messages.filter(isValidShippedMessageItem);

      if (messages.length !== payload.messages.length) {
        return data(
          {
            error:
              "Each shipped message must include an orderNumber, sellerKey, and easypostShipmentId.",
          },
          { status: 400 },
        );
      }

      const response = await sendMessages(messages);
      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
