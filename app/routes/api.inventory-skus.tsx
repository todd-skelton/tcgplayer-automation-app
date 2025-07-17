import { data } from "react-router";
import { productsDb, setProductsDb, skusDb } from "../datastores";
import type { Product } from "../data-types/product";
import type { SetProduct } from "../data-types/setProduct";
import type { Sku } from "../data-types/sku";

export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");
    const skuIds = url.searchParams.get("skuIds");

    // Handle SKU IDs query parameter
    if (skuIds) {
      const skuIdArray = skuIds
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => !isNaN(id) && id > 0);

      if (skuIdArray.length === 0) {
        return data({ error: "Invalid skuIds parameter" }, { status: 400 });
      }

      // Fetch SKUs directly from the SKU database
      const skus = await skusDb.find<Sku>({ sku: { $in: skuIdArray } });

      if (!skus || skus.length === 0) {
        return data({ skus: [] }, { status: 200 });
      }

      // Get product and set product information for enhanced display names
      const productIds = [...new Set(skus.map((sku) => sku.productId))];
      const [products, setProducts] = await Promise.all([
        productsDb.find<Product>({ productId: { $in: productIds } }),
        setProductsDb.find<SetProduct>({ productId: { $in: productIds } }),
      ]);

      // Create maps for fast lookup
      const productMap = new Map<number, Product>();
      products.forEach((product) => {
        productMap.set(product.productId, product);
      });

      const setProductMap = new Map<number, SetProduct>();
      setProducts.forEach((setProduct) => {
        setProductMap.set(setProduct.productId, setProduct);
      });

      // Enhance SKUs with product and set information
      const enhancedSkus = skus.map((sku) => {
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
          originalProductName: product.productName, // Keep original for enhanced display name creation
          productTypeName: product.productTypeName,
          rarityName: product.rarityName,
          sealed: product.sealed,
          setName: product.setName,
          setCode: product.setCode,
          productLineName: product.productLineName,
          productStatusId: product.productStatusId,
          cardNumber: setProduct?.number || null, // Include card number for enhanced display names
        };
      });

      return data({ skus: enhancedSkus }, { status: 200 });
    }

    // Handle product ID query parameter (existing functionality)
    if (!productId) {
      return data(
        { error: "productId or skuIds is required" },
        { status: 400 }
      );
    }

    // Get SKUs directly from the product database and corresponding set product info
    const product = await productsDb.findOne<Product>({
      productId: Number(productId),
    });

    if (!product) {
      return data({ error: "Product not found" }, { status: 404 });
    }

    // Get set product information for card number
    const setProduct = await setProductsDb.findOne<SetProduct>({
      productId: Number(productId),
    });

    // Create display name with card number if available
    const displayName =
      setProduct?.number && !product.productName.includes(setProduct.number)
        ? `${product.productName} (#${setProduct.number})`
        : product.productName;

    // Convert ProductSku to full Sku format if needed by adding product information
    const skus = product.skus.map((sku) => ({
      ...sku,
      productTypeName: product.productTypeName,
      rarityName: product.rarityName,
      sealed: product.sealed,
      productName: displayName, // Use enhanced product name with card number
      setId: product.setId,
      setCode: product.setCode,
      productId: product.productId,
      setName: product.setName,
      productLineId: product.productLineId,
      productStatusId: product.productStatusId,
      productLineName: product.productLineName,
    }));

    return data(skus, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const { skuIds } = await request.json();

    if (!skuIds || !Array.isArray(skuIds)) {
      return data({ error: "skuIds array is required" }, { status: 400 });
    }

    // Fetch SKUs directly from the SKU database
    const skus = await skusDb.find<Sku>({ sku: { $in: skuIds } });

    if (!skus || skus.length === 0) {
      return data([], { status: 200 });
    }

    // Get product and set product information for enhanced display names
    const productIds = [...new Set(skus.map((sku) => sku.productId))];
    const [products, setProducts] = await Promise.all([
      productsDb.find<Product>({ productId: { $in: productIds } }),
      setProductsDb.find<SetProduct>({ productId: { $in: productIds } }),
    ]);

    // Create maps for fast lookup
    const productMap = new Map<number, Product>();
    products.forEach((product) => {
      productMap.set(product.productId, product);
    });

    const setProductMap = new Map<number, SetProduct>();
    setProducts.forEach((setProduct) => {
      setProductMap.set(setProduct.productId, setProduct);
    });

    // Enhance SKUs with product and set information
    const enhancedSkus = skus.map((sku) => {
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
