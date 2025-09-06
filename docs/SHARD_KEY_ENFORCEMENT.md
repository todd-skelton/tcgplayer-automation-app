# Shard Key Enforcement for Database Operations

## Overview

We have updated the ShardedDatastoreManager to enforce shard key usage for all database operations, preventing accidental cross-shard queries that hurt performance.

## New API Design

### Regular Operations (Require Shard Key)

All regular database operations now require the shard key (`productLineId` for products/skus) to be present in the query:

```typescript
// ✅ Correct - includes productLineId
const products = await productsDb.find({
  setId: 123,
  productLineId: 1,
});

// ❌ Error - missing productLineId
const products = await productsDb.find({ setId: 123 });
// Throws: "Query must include productLineId for shard targeting. Use crossShardFind() for cross-shard queries."
```

### Cross-Shard Operations (Explicit)

When cross-shard queries are necessary, explicit methods are provided:

```typescript
// Cross-shard search (use sparingly)
const product = await productsDb.crossShardFindOne({ productId: 12345 });
const allProducts = await productsDb.crossShardFind({
  rarityName: "Mythic Rare",
});
const totalCount = await productsDb.crossShardCount({});
```

### Convenience Functions

The `datastores.ts` file provides convenience functions for getting specific shards:

```typescript
import { getProductsDbShard, getSkusDbShard } from "../datastores";

// Get a specific shard
const mtgProducts = getProductsDbShard(1); // Magic: The Gathering
const pokemonSkus = getSkusDbShard(2); // Pokemon

// Use the shard directly
const products = await mtgProducts.find({ setId: 123 });
```

## Migration Strategy

### 1. Update Imports

```typescript
// Before
import { productsDb, skusDb } from "../datastores";

// After - keep for cross-shard operations
import {
  productsDb,
  skusDb,
  getProductsDbShard,
  getSkusDbShard,
} from "../datastores";
```

### 2. Update Queries with Known Product Line ID

```typescript
// Before
const products = await productsDb.find({ setId: 123 });

// After
const products = await productsDb.find({ setId: 123, productLineId: 1 });
```

### 3. Use Cross-Shard Methods When Needed

```typescript
// Before
const product = await productsDb.findOne({ productId: 12345 });

// After
const product = await productsDb.crossShardFindOne({ productId: 12345 });
```

### 4. Look Up Product Line ID When Missing

```typescript
// When you only have a productLineName
const productLine = await productLinesDb.findOne({
  productLineName: "Magic: The Gathering",
});
const products = await productsDb.find({
  setId: 123,
  productLineId: productLine.productLineId,
});
```

## Files Updated

### Core Infrastructure

- ✅ `app/core/datastores/ShardedDatastoreManager.ts` - Enforces shard key usage
- ✅ `app/datastores.ts` - Provides convenience functions

### API Routes

- ✅ `app/routes/home.tsx` - Main application routes
- ✅ `app/features/inventory-management/routes/api.inventory-skus-by-set.tsx`
- ✅ `app/features/inventory-management/routes/api.inventory-skus.tsx`
- ✅ `app/features/pricing/routes/api.validate-skus.tsx`
- ✅ `app/features/pricing/routes/api.suggested-price.tsx`

## Error Handling

The new system provides clear error messages:

```typescript
// Missing shard key in regular operation
Error: "Query must include productLineId for shard targeting. Use crossShardFind() for cross-shard queries.";

// Empty query in count operation
Error: "Empty query not allowed. Use crossShardCount() for counting across all shards.";

// Missing shard key in document insertion
Error: "Document must include productLineId for shard targeting";
```

## Performance Benefits

1. **Prevents Accidental Cross-Shard Queries**: All queries must specify the shard key
2. **Clear Intent**: Cross-shard operations are explicit and obvious in code
3. **Better Performance**: Most operations target specific shards
4. **Future-Proof**: Generic shard key design supports other sharding strategies

## Best Practices

1. **Always include productLineId** when you know it
2. **Use cross-shard methods sparingly** - they're slower
3. **Look up productLineId first** when you only have other identifiers
4. **Prefer specific shards** over the manager for repeated operations on the same product line

## Example Patterns

### Efficient Product Lookup

```typescript
// When you know the product line
const mtgProductsDb = getProductsDbShard(1);
const product = await mtgProductsDb.findOne({ productId: 12345 });

// When you don't know the product line (less efficient)
const product = await productsDb.crossShardFindOne({ productId: 12345 });
```

### Bulk Operations

```typescript
// Group by product line for efficient bulk operations
const productsByLine = new Map();
products.forEach((p) => {
  if (!productsByLine.has(p.productLineId)) {
    productsByLine.set(p.productLineId, []);
  }
  productsByLine.get(p.productLineId).push(p);
});

// Process each product line separately
for (const [productLineId, products] of productsByLine) {
  const shard = getProductsDbShard(productLineId);
  await shard.insert(products);
}
```
