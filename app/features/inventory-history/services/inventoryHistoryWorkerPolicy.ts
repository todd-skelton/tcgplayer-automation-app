export function inventoryHistoryWorkerEnabled(value = process.env.INVENTORY_HISTORY_WORKER_ENABLED): boolean {
  return !["0", "false", "off", "disabled"].includes(value?.trim().toLowerCase() ?? "");
}
