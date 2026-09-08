import { data } from "react-router";
import { inventoryHistoryDiagnosticsRepository } from "~/core/db";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";

export function createInventoryHistoryDiagnosticsLoader(dependencies = {
  getConfig: getShippingExportConfig,
  getDiagnostics: inventoryHistoryDiagnosticsRepository.get,
}) {
  return async () => {
    try {
      const sellerKey = (await dependencies.getConfig()).defaultSellerKey.trim();
      if (!sellerKey) return data({ error: "A default shipping seller is required." }, { status: 409 });
      return data({ diagnostics: await dependencies.getDiagnostics(sellerKey) });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
