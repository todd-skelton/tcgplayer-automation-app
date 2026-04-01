import { data } from "react-router";
import {
  categorySetsRepository,
  productsRepository,
  setProductsRepository,
} from "~/core/db";
import type { Sku } from "~/shared/data-types/sku";
import type { SetProduct } from "~/shared/data-types/setProduct";

interface SkuWithDisplayInfo extends Sku {
  cardNumber?: string | null;
  setNameId?: number;
  setReleaseDate?: string;
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

    const parsedProductLineId = Number(productLineId);
    const matchedSetProducts = await setProductsRepository.findByCardNumber(
      parsedProductLineId,
      cardNumber,
    );

    if (matchedSetProducts.length === 0) {
      return data([], { status: 200 });
    }

    const [products, categorySets] = await Promise.all([
      productsRepository.findByIds(
        matchedSetProducts.map((setProduct) => setProduct.productId),
        parsedProductLineId,
      ),
      categorySetsRepository.findByCategoryIdAndSetNameIds(
        parsedProductLineId,
        [...new Set(matchedSetProducts.map((setProduct) => setProduct.setNameId))],
      ),
    ]);

    const productMap = new Map(
      products.map((product) => [product.productId, product]),
    );
    const categorySetMap = new Map(
      categorySets.map((categorySet) => [categorySet.setNameId, categorySet]),
    );

    const allSkus: SkuWithDisplayInfo[] = matchedSetProducts.flatMap(
      (setProduct: SetProduct) => {
        const product = productMap.get(setProduct.productId);
        const categorySet = categorySetMap.get(setProduct.setNameId);

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
          setNameId: setProduct.setNameId,
          setReleaseDate: categorySet?.releaseDate,
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
