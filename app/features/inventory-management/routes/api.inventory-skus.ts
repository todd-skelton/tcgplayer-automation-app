import { data } from "react-router";
import type { Product } from "../types/product";
import type { SetProduct } from "~/shared/data-types/setProduct";
import type { Sku } from "~/shared/data-types/sku";
import { skusDb, productsDb, setProductsDb } from "~/datastores.server";

export async function loader() {
  // This endpoint now only supports POST requests
  return data(
    {
      error:
        "This endpoint only supports POST requests. Use POST with { productLineSkus: { [productLineId]: skuIds[] } } in request body.",
    },
    { status: 405 }
  );
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const { productLineSkus } = await request.json();

    if (!productLineSkus || typeof productLineSkus !== "object") {
      return data(
        {
          error:
            "productLineSkus object is required with format: { [productLineId]: skuIds[] }",
        },
        { status: 400 }
      );
    }

    // Validate the structure and collect all SKUs
    const allSkus: Sku[] = [];
    const productLineIds = Object.keys(productLineSkus)
      .map(Number)
      .filter((id) => !isNaN(id));

    if (productLineIds.length === 0) {
      return data(
        { error: "No valid product line IDs provided" },
        { status: 400 }
      );
    }

    // Process each product line group separately for optimal shard targeting

    for (const productLineId of productLineIds) {
      const skuIds = productLineSkus[productLineId.toString()];

      if (!Array.isArray(skuIds) || skuIds.length === 0) {
        continue; // Skip empty arrays
      }

      // Validate SKU IDs
      const validSkuIds = skuIds
        .map((id) => Number(id))
        .filter((id) => !isNaN(id) && id > 0);
      if (validSkuIds.length === 0) {
        continue; // Skip if no valid SKU IDs
      }

      // Fetch SKUs for this product line using shard-targeted query
      const skus = await skusDb.find<Sku>({
        sku: { $in: validSkuIds },
        productLineId: productLineId,
      });

      if (skus && skus.length > 0) {
        allSkus.push(...skus);
      }
    }

    if (allSkus.length === 0) {
      return data([], { status: 200 });
    }

    // Get product and set product information for enhanced display names
    const productIds = [...new Set(allSkus.map((sku) => sku.productId))];
    const allProductLineIds = [
      ...new Set(allSkus.map((sku) => sku.productLineId)),
    ];

    // Fetch products using shard-targeted queries grouped by product line
    const allProducts: Product[] = [];
    for (const productLineId of allProductLineIds) {
      const productIdsForLine = [
        ...new Set(
          allSkus
            .filter((sku) => sku.productLineId === productLineId)
            .map((sku) => sku.productId)
        ),
      ];

      const products = await productsDb.find<Product>({
        productId: { $in: productIdsForLine },
        productLineId: productLineId,
      });

      if (products && products.length > 0) {
        allProducts.push(...products);
      }
    }

    const setProducts = await setProductsDb.find<SetProduct>({
      productId: { $in: productIds },
    });

    // Create maps for fast lookup
    const productMap = new Map<number, Product>();
    allProducts.forEach((product) => {
      productMap.set(product.productId, product);
    });

    const setProductMap = new Map<number, SetProduct>();
    setProducts.forEach((setProduct) => {
      setProductMap.set(setProduct.productId, setProduct);
    });

    // Enhance SKUs with product and set information
    const enhancedSkus = allSkus.map((sku) => {
      const product = productMap.get(sku.productId);
      const setProduct = setProductMap.get(sku.productId);

      if (!product) {
        // If product is not found, return basic SKU info
        return sku;
      }

      // Create display name with card number if available
      const displayName =
        setProduct?.number && !product.productName.includes(setProduct.number)
          ? `${product.productName} (#${setProduct.number})`
          : product.productName;

      return {
        ...sku,
        productName: displayName,
        productTypeName: product.productTypeName,
        rarityName: product.rarityName,
        sealed: product.sealed,
        setName: product.setName,
        setCode: product.setCode,
        productLineName: product.productLineName,
        productStatusId: product.productStatusId,
      };
    });

    return data(enhancedSkus, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
