import { createInventoryEconomicsHandlers } from "./api.inventory-economics.server";
const handlers = createInventoryEconomicsHandlers();
export const loader = handlers.loader;
export const action = handlers.action;
