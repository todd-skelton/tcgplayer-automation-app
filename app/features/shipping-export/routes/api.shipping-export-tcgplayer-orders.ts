import { createShippingTcgplayerOrdersAction } from "./api.shipping-export-tcgplayer-orders.server";
import { sellerOrderHistoryRepository } from "~/core/db";

export const action = createShippingTcgplayerOrdersAction({
  getHistoryCoverage: (sellerKey) => sellerOrderHistoryRepository.getCoverage(sellerKey),
});
