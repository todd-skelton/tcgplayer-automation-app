# Datastore Sharding Implementation

This document describes the sharding implementation for the TCGPlayer Automation App datastores to improve performance and reduce memory usage.

## Overview

The application has been updated to use sharded datastores for `products` and `skus` databases. Instead of having monolithic databases that can be hundreds of MB or GB in size, the data is now partitioned by `productLineId` into smaller, more manageable files.

## Benefits

- **Reduced Memory Usage**: Only load the product lines you're working with
- **Faster Queries**: Smaller datasets mean faster search and retrieval
- **Better Performance**: Less data to index and search through
- **Scalability**: Each product line can grow independently

## File Structure

### Before (Monolithic)

```
data/
├── products.db      (500MB)
├── skus.db          (2GB)
└── ...
```

### After (Sharded)

```
data/
├── products-1.db    (Magic: The Gathering products)
├── products-2.db    (Pokemon products)
├── products-3.db    (Yu-Gi-Oh! products)
├── skus-1.db        (Magic: The Gathering SKUs)
├── skus-2.db        (Pokemon SKUs)
├── skus-3.db        (Yu-Gi-Oh! SKUs)
└── ...
```

## How It Works

### ShardedDatastoreManager

The `ShardedDatastoreManager` class handles routing queries to the appropriate shard based on the `productLineId`. It provides the same interface as the original NeDB datastores, so existing code continues to work without modification.

```typescript
// Automatically routes to the correct shard
const products = await productsDb.find({ productLineId: 1 });

// Cross-shard queries also work
const allProducts = await productsDb.find({});
```

### Smart Query Routing

- **Single Product Line**: When `productLineId` is in the query, only that shard is accessed
- **Multiple Product Lines**: When using `$in` queries, only the specified shards are accessed
- **Cross-Shard Queries**: When no `productLineId` is specified, all shards are searched

### Lazy Loading

Shards are only loaded when needed, reducing startup time and memory usage.

## Migration Process

### Running the Migration

1. **Dry Run** (recommended first):

   ```bash
   npm run migrate:dry-run
   ```

2. **Create Backups**:

   ```bash
   npm run migrate:backup
   ```

3. **Run Migration**:

   ```bash
   npm run migrate:run
   ```

4. **Validate Migration**:
   ```bash
   npm run migrate:validate
   ```

### Manual Migration Steps

If you prefer to run the migration manually:

```bash
# Install tsx if not already installed
npm install --save-dev tsx

# Run dry run to see what would happen
npx tsx scripts/migrate-to-sharded-datastores.ts --dry-run

# Create backups only
npx tsx scripts/migrate-to-sharded-datastores.ts --backup-only

# Run full migration
npx tsx scripts/migrate-to-sharded-datastores.ts --force

# Validate migration
npx tsx scripts/migrate-to-sharded-datastores.ts --validate-only
```

## Code Changes

### Updated Imports

The main `datastores.ts` file now uses sharded managers:

```typescript
// Before
export const productsDb: Datastore<Product> = Datastore.create({
  filename: path.join(dataDir, "products.db"),
  autoload: true,
});

// After
export const productsDb = shardedProductsDb;
```

### No Application Code Changes Required

All existing application code continues to work without modification. The sharded datastore managers implement the same interface as the original NeDB datastores.

## Performance Considerations

### Query Optimization

- **Include productLineId**: Always include `productLineId` in queries when possible for best performance
- **Avoid Cross-Shard Queries**: These are more expensive as they need to search all shards
- **Use Specific Product Lines**: Filter by product line in your UI to reduce the amount of data loaded

### Memory Usage

- **Selective Loading**: Only the shards you're actively using are loaded into memory
- **Reduced Startup Time**: Application starts faster as it doesn't need to load massive databases
- **Better Caching**: Smaller datasets fit better in memory and disk caches

## Monitoring

### Shard Statistics

You can get statistics about your shards:

```typescript
import {
  shardedProductsDb,
  shardedSkusDb,
} from "./core/datastores/ShardedDatastoreManager";

// Get product shard stats
const productStats = await shardedProductsDb.getShardStats();
console.log("Product shards:", productStats);

// Get SKU shard stats
const skuStats = await shardedSkusDb.getShardStats();
console.log("SKU shards:", skuStats);
```

## Troubleshooting

### Migration Issues

1. **"File not found" errors**: Original databases may already be moved/deleted
2. **Permission errors**: Ensure the application has write access to the data directory
3. **Memory errors during migration**: The migration processes data in batches to avoid memory issues

### Runtime Issues

1. **Missing data**: Check that migration completed successfully with `npm run migrate:validate`
2. **Performance issues**: Ensure queries include `productLineId` when possible
3. **Disk space**: Sharded files may temporarily use more space during migration

### Recovery

If you need to roll back:

1. Stop the application
2. Restore the backup files:

   ```bash
   # Find your backup files
   ls data/*.backup-*

   # Restore (replace timestamp with your backup)
   cp data/products.db.backup-2025-01-01T00-00-00-000Z data/products.db
   cp data/skus.db.backup-2025-01-01T00-00-00-000Z data/skus.db
   ```

3. Update `datastores.ts` to use the original implementation
4. Restart the application

## Future Enhancements

- **Automatic Archiving**: Archive old product lines that are no longer active
- **Hot/Cold Storage**: Move less frequently accessed shards to slower storage
- **Compression**: Compress inactive shards to save disk space
- **Replication**: Replicate critical shards for backup and performance
