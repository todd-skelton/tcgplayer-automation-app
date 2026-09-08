import { createShippingTcgplayerOrdersAction } from "./api.shipping-export-tcgplayer-orders.server";
import { sellerOrderHistoryRepository } from "~/core/db";
import { enrichShippingOrdersWithIntakeHistory } from "../services/shippingIntakeHistory.server";

export const action = createShippingTcgplayerOrdersAction({
  getHistoryCoverage: (sellerKey) => sellerOrderHistoryRepository.getCoverage(sellerKey),
  enrichIntakeHistory: enrichShippingOrdersWithIntakeHistory,
});
