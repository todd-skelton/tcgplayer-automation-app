import { data } from "react-router";
import { productsRepository, setProductsRepository, skusRepository } from "~/core/db";
import type { Product } from "../types/product";
import type { SetProduct } from "~/shared/data-types/setProduct";
import type { Sku } from "~/shared/data-types/sku";

export async function loader() {
  return data(
    {
      error:
        "This endpoint only supports POST requests. Use POST with { productLineSkus: { [productLineId]: skuIds[] } } in request body.",
    },
    { status: 405 },
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
        { status: 400 },
      );
    }

    const allSkus: Sku[] = [];
    const productLineIds = Object.keys(productLineSkus)
      .map(Number)
      .filter((id) => !Number.isNaN(id));

    if (productLineIds.length === 0) {
      return data({ error: "No valid product line IDs provided" }, { status: 400 });
    }

    for (const productLineId of productLineIds) {
      const skuIds = productLineSkus[productLineId.toString()];

      if (!Array.isArray(skuIds) || skuIds.length === 0) {
        continue;
      }

      const validSkuIds = skuIds
        .map((id) => Number(id))
        .filter((id) => !Number.isNaN(id) && id > 0);

      if (validSkuIds.length === 0) {
        continue;
      }

      const skus = await skusRepository.findBySkuIds(productLineId, validSkuIds);
      if (skus.length > 0) {
        allSkus.push(...skus);
      }
    }

    if (allSkus.length === 0) {
      return data([], { status: 200 });
    }

    const productIds = [...new Set(allSkus.map((sku) => sku.productId))];
    const allProductLineIds = [...new Set(allSkus.map((sku) => sku.productLineId))];
    const allProducts: Product[] = [];

    for (const productLineId of allProductLineIds) {
      const productIdsForLine = [
        ...new Set(
          allSkus
            .filter((sku) => sku.productLineId === productLineId)
            .map((sku) => sku.productId),
        ),
      ];

      const products = await productsRepository.findByIds(
        productIdsForLine,
        productLineId,
      );
      if (products.length > 0) {
        allProducts.push(...products);
      }
    }

    const setProducts = await setProductsRepository.findByProductIds(productIds);
    const productMap = new Map<number, Product>();
    const setProductMap = new Map<number, SetProduct>();

    allProducts.forEach((product) => {
      productMap.set(product.productId, product);
    });

    setProducts.forEach((setProduct) => {
      setProductMap.set(setProduct.productId, setProduct);
    });

    const enhancedSkus = allSkus.map((sku) => {
      const product = productMap.get(sku.productId);
      const setProduct = setProductMap.get(sku.productId);

      if (!product) {
        return sku;
      }

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
