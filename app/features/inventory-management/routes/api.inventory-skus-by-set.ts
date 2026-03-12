import { data } from "react-router";
import { productsRepository, setProductsRepository } from "~/core/db";
import type { SetProduct } from "~/shared/data-types/setProduct";
import type { Sku } from "~/shared/data-types/sku";

interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
}

export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const setId = url.searchParams.get("setId");
    const productLineId = url.searchParams.get("productLineId");

    if (!setId) {
      return data({ error: "setId is required" }, { status: 400 });
    }

    const [products, setProducts] = await Promise.all([
      productsRepository.findBySetId(
        Number(setId),
        productLineId ? Number(productLineId) : undefined,
      ),
      setProductsRepository.findBySetNameId(Number(setId)),
    ]);

    if (products.length === 0) {
      return data([], { status: 200 });
    }

    const setProductMap = new Map<number, SetProduct>();
    setProducts.forEach((setProduct) => {
      setProductMap.set(setProduct.productId, setProduct);
    });

    const allSkus: SkuWithDisplayInfo[] = products.flatMap((product) => {
      const setProduct = setProductMap.get(product.productId);

      return product.skus.map((sku) => ({
        ...sku,
        productTypeName: product.productTypeName,
        rarityName: product.rarityName,
        sealed: product.sealed,
        productName: product.productName,
        cardNumber: setProduct?.number ?? null,
        setId: product.setId,
        setCode: product.setCode,
        productId: product.productId,
        setName: product.setName,
        productLineId: product.productLineId,
        productStatusId: product.productStatusId,
        productLineName: product.productLineName,
      }));
    });

    return data(allSkus, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
