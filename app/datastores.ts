import Datastore from "nedb-promises";
import path from "path";
import type { Sku } from "./data-types/sku";
import type { CategorySet } from "./data-types/categorySet";
import type { SetProduct } from "./data-types/setProduct";
import type { Product } from "./data-types/product";

const dataDir = path.resolve(process.cwd(), "data");

export const categorySetsDb: Datastore<CategorySet> = Datastore.create({
  filename: path.join(dataDir, "categorySets.db"),
  autoload: true,
});

export const setProductsDb: Datastore<SetProduct> = Datastore.create({
  filename: path.join(dataDir, "setProducts.db"),
  autoload: true,
});

export const productsDb: Datastore<Product> = Datastore.create({
  filename: path.join(dataDir, "products.db"),
  autoload: true,
});

export const skusDb: Datastore<Sku> = Datastore.create({
  filename: path.join(dataDir, "skus.db"),
  autoload: true,
});

categorySetsDb.ensureIndex({ fieldName: "categoryId" });
categorySetsDb.ensureIndex({ fieldName: "setNameId", unique: true });

setProductsDb.ensureIndex({ fieldName: "setId" });
setProductsDb.ensureIndex({ fieldName: "productId", unique: true });
setProductsDb.ensureIndex({ fieldName: "categoryId" });

productsDb.ensureIndex({ fieldName: "productId", unique: true });
productsDb.ensureIndex({ fieldName: "categoryId" });
productsDb.ensureIndex({ fieldName: "setId" });

skusDb.ensureIndex({ fieldName: "productId" });
skusDb.ensureIndex({ fieldName: "sku", unique: true });
