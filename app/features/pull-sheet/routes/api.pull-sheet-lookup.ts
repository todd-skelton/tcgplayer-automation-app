import { data } from "react-router";
import { productLinesRepository, skusRepository } from "~/core/db";
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
      return data({ error: "items array is required" }, { status: 400 });
    }

    const allProductLines = await productLinesRepository.findAll();
    const productLineNameMap = new Map<string, ProductLine>();
    allProductLines.forEach((productLine) => {
      productLineNameMap.set(productLine.productLineName.toLowerCase(), productLine);
    });

    const skusByProductLine = new Map<number, number[]>();

    for (const item of items) {
      const mappedProductLineName = mapPullSheetProductLineName(
        item.productLineName,
      );
      const productLine = productLineNameMap.get(
        mappedProductLineName.toLowerCase(),
      );

      if (!productLine) {
        continue;
      }

      if (!skusByProductLine.has(productLine.productLineId)) {
        skusByProductLine.set(productLine.productLineId, []);
      }
      skusByProductLine.get(productLine.productLineId)!.push(item.skuId);
    }

    const allFoundSkus: Sku[] = [];

    for (const [productLineId, skuIds] of skusByProductLine) {
      const foundSkus = await skusRepository.findBySkuIds(productLineId, skuIds);
      if (foundSkus.length > 0) {
        allFoundSkus.push(...foundSkus);
      }
    }

    const skuMap: Record<number, Sku> = {};
    allFoundSkus.forEach((sku) => {
      skuMap[sku.sku] = sku;
    });

    return data({ skuMap }, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
