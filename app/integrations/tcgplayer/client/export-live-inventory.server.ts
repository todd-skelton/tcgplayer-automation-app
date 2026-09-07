import { sellerPortal } from "~/core/clients";

export function getSellerPricingContext(options?: { signal?: AbortSignal }) {
  return sellerPortal.get<string>("/admin/pricing", undefined, {
    responseType: "text", retry: false, signal: options?.signal, timeout: 30_000,
  });
}

export function exportLiveSellerInventory(options?: { signal?: AbortSignal }) {
  return sellerPortal.get<string>(
    "/Admin/Pricing/DownloadMyExportCSV?type=Pricing",
    undefined,
    { responseType: "text", retry: false, signal: options?.signal, timeout: 30_000 },
  );
}
