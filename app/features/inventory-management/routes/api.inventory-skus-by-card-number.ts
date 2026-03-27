import { data } from "react-router";
import { productsRepository, setProductsRepository } from "~/core/db";
import type { Sku } from "~/shared/data-types/sku";
import type { SetProduct } from "~/shared/data-types/setProduct";

interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
}

export async function loader({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    const productLineId = url.searchParams.get("productLineId");
    const cardNumber = url.searchParams.get("cardNumber")?.trim() ?? "";

    if (!productLineId) {
      return data({ error: "productLineId is required" }, { status: 400 });
    }

    if (!cardNumber) {
      return data([], { status: 200 });
    }

    const matchedSetProducts = await setProductsRepository.findByCardNumber(
      Number(productLineId),
      cardNumber,
    );

    if (matchedSetProducts.length === 0) {
      return data([], { status: 200 });
    }

    const products = await productsRepository.findByIds(
      matchedSetProducts.map((setProduct) => setProduct.productId),
      Number(productLineId),
    );

    const productMap = new Map(products.map((product) => [product.productId, product]));
    const allSkus: SkuWithDisplayInfo[] = matchedSetProducts.flatMap(
      (setProduct: SetProduct) => {
        const product = productMap.get(setProduct.productId);

        if (!product) {
          return [];
        }

        return product.skus.map((sku) => ({
          ...sku,
          productTypeName: product.productTypeName,
          rarityName: product.rarityName,
          sealed: product.sealed,
          productName: product.productName,
          cardNumber: setProduct.number ?? null,
          setId: product.setId,
          setCode: product.setCode,
          productId: product.productId,
          setName: product.setName,
          productLineId: product.productLineId,
          productStatusId: product.productStatusId,
          productLineName: product.productLineName,
        }));
      },
    );

    return data(allSkus, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
