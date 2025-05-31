// migrate-to-nedb.js
const fs = require("fs/promises");
const path = require("path");
const Datastore = require("nedb-promises");

async function migrateDirToNeDB(dir, db, idField) {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    let content;
    let data;
    try {
      content = await fs.readFile(filePath, "utf-8");
      data = JSON.parse(content);
    } catch (err) {
      console.warn(`Skipping invalid JSON file: ${filePath} (${err})`);
      continue;
    }
    // If the file is an array (e.g., set-products), insert each item
    if (Array.isArray(data)) {
      for (const item of data) {
        // Upsert by idField if provided
        if (idField && item[idField]) {
          await db.update({ [idField]: item[idField] }, item, { upsert: true });
        } else {
          await db.insert(item);
        }
      }
    } else {
      // Upsert by idField if provided
      if (idField && data[idField]) {
        await db.update({ [idField]: data[idField] }, data, { upsert: true });
      } else {
        await db.insert(data);
      }
    }
  }
}

async function main() {
  console.log("Migration script started...");
  // Paths
  const dataDir = path.resolve(__dirname, "data");
  const categorySetsDir = path.join(dataDir, "category-sets");
  const setProductsDir = path.join(dataDir, "set-products");
  const productsDir = path.join(dataDir, "products");
  const skusDir = path.join(dataDir, "skus");

  // NeDB databases
  const categorySetsDb = Datastore.create({
    filename: path.join(dataDir, "categorySets.db"),
    autoload: true,
  });
  const setProductsDb = Datastore.create({
    filename: path.join(dataDir, "setProducts.db"),
    autoload: true,
  });
  const productsDb = Datastore.create({
    filename: path.join(dataDir, "products.db"),
    autoload: true,
  });
  const skusDb = Datastore.create({
    filename: path.join(dataDir, "skus.db"),
    autoload: true,
  });

  // Migrate category sets (each file is an array)
  const catSetFiles = await fs.readdir(categorySetsDir);
  for (const file of catSetFiles) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(categorySetsDir, file);
    let arr;
    try {
      arr = JSON.parse(await fs.readFile(filePath, "utf-8"));
    } catch (err) {
      console.warn(`Skipping invalid JSON file: ${filePath} (${err})`);
      continue;
    }
    if (!Array.isArray(arr)) {
      console.warn(`Skipping non-array JSON file: ${filePath}`);
      continue;
    }
    for (const obj of arr) {
      await categorySetsDb.update({ setNameId: obj.setNameId }, obj, {
        upsert: true,
      });
    }
  }

  // Migrate set-products (each file is an array)
  await migrateDirToNeDB(setProductsDir, setProductsDb, "productID");

  // Migrate products (each file is an object)
  await migrateDirToNeDB(productsDir, productsDb, "productId");

  // Migrate skus (each file is an object)
  await migrateDirToNeDB(skusDir, skusDb, "sku");

  console.log("Migration to NeDB complete!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
});
