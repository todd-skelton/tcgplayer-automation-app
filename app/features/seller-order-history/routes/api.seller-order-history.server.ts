import { data } from "react-router";
import { sellerOrderHistoryRepository } from "~/core/db";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";
import {
  importSellerOrderCsv,
  MAX_SELLER_ORDER_CSV_BYTES,
} from "../services/sellerOrderFileImport.server";
import { synchronizeSellerOrders } from "../services/synchronizeSellerOrders.server";

type Dependencies = {
  getConfig: typeof getShippingExportConfig;
  getCoverage: typeof sellerOrderHistoryRepository.getCoverage;
  synchronize: typeof synchronizeSellerOrders;
  importCsv: typeof importSellerOrderCsv;
};

const defaults: Dependencies = {
  getConfig: getShippingExportConfig,
  getCoverage: (sellerKey) => sellerOrderHistoryRepository.getCoverage(sellerKey),
  synchronize: synchronizeSellerOrders,
  importCsv: importSellerOrderCsv,
};

async function resolveSellerKey(value: unknown, getConfig: Dependencies["getConfig"]): Promise<string> {
  const provided = typeof value === "string" ? value.trim() : "";
  if (provided) return provided;
  const config = await getConfig();
  const configured = config.defaultSellerKey.trim();
  if (!configured) throw new Error("A seller key is required.");
  return configured;
}

export function createSellerOrderHistoryHandlers(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return {
    loader: async ({ request }: { request: Request }) => {
      try {
        const url = new URL(request.url);
        const sellerKey = await resolveSellerKey(url.searchParams.get("sellerKey"), dependencies.getConfig);
        return data({ coverage: await dependencies.getCoverage(sellerKey) }, { status: 200 });
      } catch (error) {
        return data({ error: String(error) }, { status: 400 });
      }
    },
    action: async ({ request }: { request: Request }) => {
      if (request.method !== "POST") return data({ error: "Method not allowed" }, { status: 405 });
      try {
        const payload = await request.json() as Record<string, unknown>;
        const sellerKey = await resolveSellerKey(payload.sellerKey, dependencies.getConfig);
        if (payload.action === "catch_up") {
          const priorityOrderNumbers = Array.isArray(payload.orderNumbers)
            ? payload.orderNumbers.filter((value): value is string => typeof value === "string").slice(0, 25)
            : [];
          const result = await dependencies.synchronize(
            sellerKey,
            {},
            {},
            priorityOrderNumbers,
          );
          return data(result, { status: 200 });
        }
        if (payload.action === "import_csv") {
          if (typeof payload.csvText !== "string" || !payload.csvText.trim()) {
            return data({ error: "A seller order CSV file is required." }, { status: 400 });
          }
          if (Buffer.byteLength(payload.csvText, "utf8") > MAX_SELLER_ORDER_CSV_BYTES) {
            return data({ error: "Seller order CSV exceeds the 5 MB limit." }, { status: 413 });
          }
          const result = await dependencies.importCsv({
            sellerKey,
            csvText: payload.csvText,
            ...(typeof payload.fileName === "string" ? { fileName: payload.fileName } : {}),
          });
          return data({ result, coverage: await dependencies.getCoverage(sellerKey) }, { status: 200 });
        }
        return data({ error: "Unknown seller order history action." }, { status: 400 });
      } catch (error) {
        return data({ error: String(error) }, { status: 500 });
      }
    },
  };
}
