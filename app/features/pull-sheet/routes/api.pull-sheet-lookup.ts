import { data } from "react-router";
import {
  productLinesDb,
  getSkusDbShard,
} from "~/datastores.server";
import type { ProductLine } from "~/shared/data-types/productLine";
import type { Sku } from "~/shared/data-types/sku";
import { mapPullSheetProductLineName } from "../utils/productLineNameMap";

interface PullSheetLookupRequest {
  items: Array<{
    skuId: number;
    productLineName: string;
  }>;
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const { items } = (await request.json()) as PullSheetLookupRequest;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return data(
        { error: "items array is required" },
        { status: 400 }
      );
    }

    // Get all product lines to map names to IDs
    const allProductLines = await productLinesDb.find<ProductLine>({});
    const productLineNameMap = new Map<string, ProductLine>();
    allProductLines.forEach((pl) => {
      // Map by exact name and lowercase for flexible matching
      productLineNameMap.set(pl.productLineName.toLowerCase(), pl);
    });

    // Group SKU IDs by product line ID for efficient shard queries
    const skusByProductLine = new Map<number, number[]>();
    const skuToProductLine = new Map<number, number>();

    for (const item of items) {
      const mappedProductLineName = mapPullSheetProductLineName(
        item.productLineName
      );
      const productLine = productLineNameMap.get(
        mappedProductLineName.toLowerCase()
      );
      if (!productLine) {
        continue; // Skip items with unknown product lines
      }

      const productLineId = productLine.productLineId;
      skuToProductLine.set(item.skuId, productLineId);

      if (!skusByProductLine.has(productLineId)) {
        skusByProductLine.set(productLineId, []);
      }
      skusByProductLine.get(productLineId)!.push(item.skuId);
    }

    // Query each shard for its SKUs
    const allFoundSkus: Sku[] = [];

    for (const [productLineId, skuIds] of skusByProductLine) {
      const skusDb = getSkusDbShard(productLineId);
      const foundSkus = await skusDb.find<Sku>({
        sku: { $in: skuIds },
        productLineId,
      });
      if (foundSkus && foundSkus.length > 0) {
        allFoundSkus.push(...foundSkus);
      }
    }

    // Build a map of skuId -> Sku for fast lookup
    const skuMap: Record<number, Sku> = {};
    allFoundSkus.forEach((sku) => {
      skuMap[sku.sku] = sku;
    });

    return data({ skuMap }, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
