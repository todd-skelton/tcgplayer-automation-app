import Datastore from "nedb-promises";
import path from "path";
import type { CategorySet } from "./shared/data-types/categorySet";
import type { SetProduct } from "./shared/data-types/setProduct";
import type { ProductLine } from "./shared/data-types/productLine";
import type { CategoryFilter } from "./shared/data-types/categoryFilter";
import type { PendingInventoryEntry } from "./features/pending-inventory/types/pendingInventory";
import type { HttpConfig } from "./core/config/httpConfig.server";
import {
  shardedProductsDb,
  shardedSkusDb,
} from "./core/datastores/ShardedDatastoreManager.server";

const dataDir = path.resolve(process.cwd(), "data");

export const categorySetsDb: Datastore<CategorySet> = Datastore.create({
  filename: path.join(dataDir, "categorySets.db"),
  autoload: true,
});

export const setProductsDb: Datastore<SetProduct> = Datastore.create({
  filename: path.join(dataDir, "setProducts.db"),
  autoload: true,
});

// Use sharded datastores for products and skus to improve performance
// These functions require a productLineId (shard key) to be passed
export const getProductsDbShard = (productLineId: number) =>
  shardedProductsDb.getShard(productLineId);

export const getSkusDbShard = (productLineId: number) =>
  shardedSkusDb.getShard(productLineId);

// Legacy exports for backward compatibility - will be removed after migration
// These will throw errors if queries don't include productLineId
export const productsDb = shardedProductsDb;
export const skusDb = shardedSkusDb;

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

export const httpConfigDb: Datastore<HttpConfig & { _id?: string }> =
  Datastore.create({
    filename: path.join(dataDir, "httpConfig.db"),
    autoload: true,
  });

categorySetsDb.ensureIndex({ fieldName: "categoryId" });
categorySetsDb.ensureIndex({ fieldName: "setNameId", unique: true });
categorySetsDb.ensureIndex({ fieldName: "urlName" });

setProductsDb.ensureIndex({ fieldName: "setId" });
setProductsDb.ensureIndex({ fieldName: "productId", unique: true });
setProductsDb.ensureIndex({ fieldName: "categoryId" });

// Indexes for sharded datastores are managed by the ShardedDatastoreManager
// No need to explicitly call ensureIndex here as it's handled during shard creation

productLinesDb.ensureIndex({ fieldName: "productLineId", unique: true });

categoryFiltersDb.ensureIndex({ fieldName: "categoryId", unique: true });

pendingInventoryDb.ensureIndex({ fieldName: "sku", unique: true });
pendingInventoryDb.ensureIndex({ fieldName: "createdAt" });
pendingInventoryDb.ensureIndex({ fieldName: "productLineId" });
pendingInventoryDb.ensureIndex({ fieldName: "setId" });
pendingInventoryDb.ensureIndex({ fieldName: "productId" });
