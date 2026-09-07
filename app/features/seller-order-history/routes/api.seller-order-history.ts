import { createSellerOrderHistoryHandlers } from "./api.seller-order-history.server";

const handlers = createSellerOrderHistoryHandlers();
export const loader = handlers.loader;
export const action = handlers.action;
