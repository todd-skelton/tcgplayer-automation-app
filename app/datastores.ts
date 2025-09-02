import Datastore from "nedb-promises";
import path from "path";
import type { Sku } from "./shared/data-types/sku";
import type { CategorySet } from "./shared/data-types/categorySet";
import type { SetProduct } from "./shared/data-types/setProduct";
import type { Product } from "./features/inventory-management/types/product";
import type { ProductLine } from "./shared/data-types/productLine";
import type { CategoryFilter } from "./shared/data-types/categoryFilter";
import type { PendingInventoryEntry } from "./features/pending-inventory/types/pendingInventory";

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

export const productLinesDb: Datastore<ProductLine> = Datastore.create({
  filename: path.join(dataDir, "productLines.db"),
  autoload: true,
});

export const categoryFiltersDb: Datastore<CategoryFilter> = Datastore.create({
  filename: path.join(dataDir, "categoryFilters.db"),
  autoload: true,
});

export const pendingInventoryDb: Datastore<PendingInventoryEntry> =
  Datastore.create({
    filename: path.join(dataDir, "pendingInventory.db"),
    autoload: true,
  });

categorySetsDb.ensureIndex({ fieldName: "categoryId" });
categorySetsDb.ensureIndex({ fieldName: "setNameId", unique: true });
categorySetsDb.ensureIndex({ fieldName: "urlName" });

setProductsDb.ensureIndex({ fieldName: "setId" });
setProductsDb.ensureIndex({ fieldName: "productId", unique: true });
setProductsDb.ensureIndex({ fieldName: "categoryId" });

productsDb.ensureIndex({ fieldName: "productId", unique: true });
productsDb.ensureIndex({ fieldName: "categoryId" });
productsDb.ensureIndex({ fieldName: "setId" });

skusDb.ensureIndex({ fieldName: "productId" });
skusDb.ensureIndex({ fieldName: "sku", unique: true });
skusDb.ensureIndex({ fieldName: "setId" });

productLinesDb.ensureIndex({ fieldName: "productLineId", unique: true });

categoryFiltersDb.ensureIndex({ fieldName: "categoryId", unique: true });

pendingInventoryDb.ensureIndex({ fieldName: "sku" });
pendingInventoryDb.ensureIndex({ fieldName: "createdAt" });
