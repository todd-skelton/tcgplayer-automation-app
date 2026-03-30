import { data } from "react-router";
import type { TcgPlayerListing } from "~/core/types/pricing";
import type { SellerInventoryItem } from "~/features/inventory-management/services/inventoryConverter";
import {
  convertBatchItemsToPricerSkus,
  convertCsvListingsToBatchItems,
  convertSellerInventoryToBatchItems,
} from "~/features/file-upload/services/pricingBatchSnapshots.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();
    const { listings, type } = body;

    if (!listings || !Array.isArray(listings)) {
      return data({ error: "listings array is required" }, { status: 400 });
    }

    if (!type || (type !== "csv" && type !== "seller-inventory")) {
      return data(
        { error: "type must be either 'csv' or 'seller-inventory'" },
        { status: 400 },
      );
    }

    const batchItems =
      type === "csv"
        ? await convertCsvListingsToBatchItems(listings as TcgPlayerListing[])
        : await convertSellerInventoryToBatchItems(
            listings as SellerInventoryItem[],
          );

    return data({
      pricerSkus: convertBatchItemsToPricerSkus(batchItems),
      totalProcessed: listings.length,
      validSkus: batchItems.length,
    });
  } catch (error) {
    console.error("Error in convert-to-pricer-sku action:", error);
    return data({ error: String(error) }, { status: 500 });
  }
}
