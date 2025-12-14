import Datastore from "nedb-promises";
import path from "path";
import type { Product } from "../../features/inventory-management/types/product";
import type { Sku } from "../../shared/data-types/sku";

/**
 * Manages sharded datastores based on a shard key to improve performance
 * by reducing file sizes and memory usage.
 */
export class ShardedDatastoreManager<T extends Record<string, any>> {
  private shards = new Map<number, Datastore<T>>();
  private readonly dataDir: string;
  private readonly dbPrefix: string;
  private readonly shardKeyField: string;
  private readonly indexConfigs: Array<{ fieldName: string; unique?: boolean }>;

  constructor(
    dataDir: string,
    dbPrefix: string,
    shardKeyField: string,
    indexConfigs: Array<{ fieldName: string; unique?: boolean }> = []
  ) {
    this.dataDir = dataDir;
    this.dbPrefix = dbPrefix;
    this.shardKeyField = shardKeyField;
    this.indexConfigs = indexConfigs;
  }

  /**
   * Gets the shard for a specific shard key value - REQUIRED for all operations
   */
  getShard(shardKey: number): Datastore<T> {
    if (!this.shards.has(shardKey)) {
      const filename = path.join(
        this.dataDir,
        `${this.dbPrefix}-${shardKey}.db`
      );

      const shard = Datastore.create({
        filename,
        autoload: true,
      }) as Datastore<T>;

      // Apply indexes to the new shard
      this.indexConfigs.forEach(({ fieldName, unique }) => {
        shard.ensureIndex({ fieldName, unique });
      });

      this.shards.set(shardKey, shard);
    }

    return this.shards.get(shardKey)!;
  }

  /**
   * Gets all loaded shards
   */
  private getAllLoadedShards(): Datastore<T>[] {
    return Array.from(this.shards.values());
  }

  /**
   * Loads all shards based on existing files in the data directory
   */
  private async loadAllShards(): Promise<Datastore<T>[]> {
    const fs = await import("fs");
    const files = await fs.promises.readdir(this.dataDir);
    const shardFiles = files.filter(
      (file) => file.startsWith(`${this.dbPrefix}-`) && file.endsWith(".db")
    );

    const productLineIds = shardFiles
      .map((file) => {
        const match = file.match(new RegExp(`${this.dbPrefix}-(\\d+)\\.db`));
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((id): id is number => id !== null);

    // Load all shards
    productLineIds.forEach((productLineId) => {
      this.getShard(productLineId);
    });

    return this.getAllLoadedShards();
  }

  /**
   * Finds documents in the appropriate shard
   * Cross-shard queries are NOT supported - use crossShardFind() instead
   */
  async find<U = T>(query: any, options?: any): Promise<U[]> {
    // Require shard key to be present in query
    if (query[this.shardKeyField] === undefined) {
      throw new Error(
        `Query must include ${this.shardKeyField} for shard targeting. Use crossShardFind() for cross-shard queries.`
      );
    }

    // If shard key is in an $in array, search specific shards
    if (query[this.shardKeyField] && query[this.shardKeyField].$in) {
      const shardKeys = query[this.shardKeyField].$in;
      const results: U[] = [];

      for (const shardKey of shardKeys) {
        const shard = this.getShard(shardKey);
        const shardQuery = { ...query };
        delete shardQuery[this.shardKeyField]; // Remove the $in query for individual shard
        const shardResults = (await shard.find(shardQuery, options)) as U[];
        results.push(...shardResults);
      }

      return results;
    }

    // Use the specific shard
    const shard = this.getShard(query[this.shardKeyField]);
    return shard.find(query, options) as Promise<U[]>;
  }

  /**
   * Cross-shard find - searches all shards (USE SPARINGLY)
   */
  async crossShardFind<U = T>(query: any, options?: any): Promise<U[]> {
    const allShards = await this.loadAllShards();
    const results: U[] = [];

    for (const shard of allShards) {
      const shardResults = (await shard.find(query, options)) as U[];
      results.push(...shardResults);
    }

    return results;
  }

  /**
   * Finds one document in the appropriate shard
   * Cross-shard queries are NOT supported - use crossShardFindOne() instead
   */
  async findOne<U = T>(query: any): Promise<U | null> {
    // Require shard key to be present in query
    if (query[this.shardKeyField] === undefined) {
      throw new Error(
        `Query must include ${this.shardKeyField} for shard targeting. Use crossShardFindOne() for cross-shard queries.`
      );
    }

    // Use the specific shard
    const shard = this.getShard(query[this.shardKeyField]);
    return shard.findOne<U>(query);
  }

  /**
   * Cross-shard findOne - searches all shards until found (USE SPARINGLY)
   */
  async crossShardFindOne<U = T>(query: any): Promise<U | null> {
    const allShards = await this.loadAllShards();

    for (const shard of allShards) {
      const result = await shard.findOne<U>(query);
      if (result) {
        return result;
      }
    }

    return null;
  }

  /**
   * Inserts documents into the appropriate shard
   */
  async insert(docs: T | T[]): Promise<T | T[]> {
    const docsArray = Array.isArray(docs) ? docs : [docs];

    // Group documents by shard key
    const docsByShardKey = new Map<number, T[]>();

    for (const doc of docsArray) {
      const shardKey = doc[this.shardKeyField];
      if (shardKey === undefined) {
        throw new Error(
          `Document must include ${this.shardKeyField} for shard targeting`
        );
      }
      if (!docsByShardKey.has(shardKey)) {
        docsByShardKey.set(shardKey, []);
      }
      docsByShardKey.get(shardKey)!.push(doc);
    }

    // Insert into appropriate shards
    const results: T[] = [];

    for (const [shardKey, shardDocs] of docsByShardKey) {
      const shard = this.getShard(shardKey);
      const insertResult = await shard.insert(shardDocs);
      const insertedDocs = Array.isArray(insertResult)
        ? insertResult
        : [insertResult];
      results.push(...insertedDocs);
    }

    return Array.isArray(docs) ? results : results[0];
  }

  /**
   * Updates documents in the appropriate shard
   * Cross-shard updates are NOT supported - use crossShardUpdate() instead
   */
  async update(query: any, update: any, options: any = {}): Promise<number> {
    // Require shard key to be present in query
    if (query[this.shardKeyField] === undefined) {
      throw new Error(
        `Query must include ${this.shardKeyField} for shard targeting. Use crossShardUpdate() for cross-shard updates.`
      );
    }

    // Use the specific shard
    const shard = this.getShard(query[this.shardKeyField]);
    return shard.update(query, update, options);
  }

  /**
   * Cross-shard update - updates all shards (USE SPARINGLY)
   */
  async crossShardUpdate(
    query: any,
    update: any,
    options: any = {}
  ): Promise<number> {
    const allShards = await this.loadAllShards();
    let totalUpdated = 0;

    for (const shard of allShards) {
      const updated = await shard.update(query, update, options);
      totalUpdated += Number(updated);
    }

    return totalUpdated;
  }

  /**
   * Removes documents from the appropriate shard
   * Cross-shard removes are NOT supported - use crossShardRemove() instead
   */
  async remove(query: any, options: any = {}): Promise<number> {
    // Require shard key to be present in query
    if (query[this.shardKeyField] === undefined) {
      throw new Error(
        `Query must include ${this.shardKeyField} for shard targeting. Use crossShardRemove() for cross-shard removes.`
      );
    }

    // Use the specific shard
    const shard = this.getShard(query[this.shardKeyField]);
    return shard.remove(query, options);
  }

  /**
   * Cross-shard remove - removes from all shards (USE SPARINGLY)
   */
  async crossShardRemove(query: any, options: any = {}): Promise<number> {
    const allShards = await this.loadAllShards();
    let totalRemoved = 0;

    for (const shard of allShards) {
      const removed = await shard.remove(query, options);
      totalRemoved += Number(removed);
    }

    return totalRemoved;
  }

  /**
   * Counts documents in the appropriate shard
   * Cross-shard counts are NOT supported - use crossShardCount() instead
   */
  async count(query: any = {}): Promise<number> {
    // Require shard key to be present in query (unless empty query)
    if (
      Object.keys(query).length > 0 &&
      query[this.shardKeyField] === undefined
    ) {
      throw new Error(
        `Query must include ${this.shardKeyField} for shard targeting. Use crossShardCount() for cross-shard counts.`
      );
    }

    // If empty query, this is probably a mistake - use crossShardCount instead
    if (Object.keys(query).length === 0) {
      throw new Error(
        `Empty query not allowed. Use crossShardCount() for counting across all shards.`
      );
    }

    // Use the specific shard
    const shard = this.getShard(query[this.shardKeyField]);
    return shard.count(query);
  }

  /**
   * Cross-shard count - counts all shards (USE SPARINGLY)
   */
  async crossShardCount(query: any = {}): Promise<number> {
    const allShards = await this.loadAllShards();
    let totalCount = 0;

    for (const shard of allShards) {
      const count = await shard.count(query);
      totalCount += count;
    }

    return totalCount;
  }

  /**
   * Ensures an index on all current and future shards
   */
  ensureIndex(options: { fieldName: string; unique?: boolean }): void {
    // Add to index configs for future shards
    this.indexConfigs.push(options);

    // Apply to existing shards
    for (const shard of this.getAllLoadedShards()) {
      shard.ensureIndex(options);
    }
  }

  /**
   * Gets statistics about the shards
   */
  async getShardStats(): Promise<{
    totalShards: number;
    loadedShards: number;
    shardCounts: Record<number, number>;
  }> {
    const allShards = await this.loadAllShards();
    const shardCounts: Record<number, number> = {};

    for (const [shardKey, shard] of this.shards) {
      shardCounts[shardKey] = await shard.count({});
    }

    return {
      totalShards: allShards.length,
      loadedShards: this.shards.size,
      shardCounts,
    };
  }
}

// Create sharded datastore managers for products and skus
const dataDir = path.resolve(process.cwd(), "data");

export const shardedProductsDb = new ShardedDatastoreManager<Product>(
  dataDir,
  "products",
  "productLineId",
  [
    { fieldName: "productId", unique: true },
    { fieldName: "categoryId" },
    { fieldName: "setId" },
    { fieldName: "productLineId" },
  ]
);

export const shardedSkusDb = new ShardedDatastoreManager<Sku>(
  dataDir,
  "skus",
  "productLineId",
  [
    { fieldName: "productId" },
    { fieldName: "sku", unique: true },
    { fieldName: "setId" },
    { fieldName: "productLineId" },
  ]
);
