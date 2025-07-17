import { data } from "react-router";
import { productsDb, setProductsDb } from "../datastores";
import type { Product } from "../data-types/product";
import type { SetProduct } from "../data-types/setProduct";
import type { Sku } from "../data-types/sku";

// Extended interface for API response that includes display information
interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null; // Card number for client-side display
}

export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const setId = url.searchParams.get("setId");

    if (!setId) {
      return data({ error: "setId is required" }, { status: 400 });
    }

    // Get all products for the set and set products for card numbers
    const [products, setProducts] = await Promise.all([
      productsDb.find<Product>({ setId: Number(setId) }),
      setProductsDb.find<SetProduct>({ setNameId: Number(setId) }),
    ]);

    if (!products || products.length === 0) {
      return data([], { status: 200 });
    }

    // Create a map of productId to SetProduct for fast lookup
    const setProductMap = new Map<number, SetProduct>();
    setProducts.forEach((setProduct) => {
      setProductMap.set(setProduct.productId, setProduct);
    });

    // Flatten all SKUs from all products in the set
    const allSkus: SkuWithDisplayInfo[] = products.flatMap((product) => {
      const setProduct = setProductMap.get(product.productId);

      return product.skus.map(
        (sku): SkuWithDisplayInfo => ({
          ...sku,
          productTypeName: product.productTypeName,
          rarityName: product.rarityName,
          sealed: product.sealed,
          productName: product.productName, // Use actual product name for validation
          cardNumber: setProduct?.number || null, // Pass card number separately for client-side display
          setId: product.setId,
          setCode: product.setCode,
          productId: product.productId,
          setName: product.setName,
          productLineId: product.productLineId,
          productStatusId: product.productStatusId,
          productLineName: product.productLineName,
        })
      );
    });

    return data(allSkus, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
