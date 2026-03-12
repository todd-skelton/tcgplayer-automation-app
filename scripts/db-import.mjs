import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;

const dataDir = path.resolve(process.cwd(), "data");
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
});
const importStartAt = process.env.IMPORT_START_AT ?? null;

function asText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function createValuesPlaceholders(rowCount, columnCount) {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const values = Array.from({ length: columnCount }, (_, columnIndex) => {
      return `$${rowIndex * columnCount + columnIndex + 1}`;
    });

    return `(${values.join(", ")})`;
  }).join(", ");
}

function parseLine(line) {
  if (!line.trim()) {
    return null;
  }

  const parsed = JSON.parse(line);

  if (parsed.$$indexCreated) {
    return null;
  }

  delete parsed._id;
  return parsed;
}

function runMigrations() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/db-migrate.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`db-migrate failed with exit code ${code}`));
    });
  });
}

async function importJsonLines(filePaths, onBatch) {
  const batch = [];
  const batchSize = 250;

  for (const filePath of filePaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      const parsed = parseLine(line);
      if (!parsed) {
        continue;
      }

      batch.push(parsed);

      if (batch.length >= batchSize) {
        await onBatch(batch.splice(0, batch.length));
      }
    }
  }

  if (batch.length > 0) {
    await onBatch(batch.splice(0, batch.length));
  }
}

async function countJsonLines(filePath) {
  let count = 0;
  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const parsed = parseLine(line);
    if (parsed) {
      count += 1;
    }
  }

  return count;
}

async function importJsonLinesFromOffset(filePath, skipCount, onBatch) {
  const batch = [];
  const batchSize = 250;
  let skipped = 0;

  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const parsed = parseLine(line);
    if (!parsed) {
      continue;
    }

    if (skipped < skipCount) {
      skipped += 1;
      continue;
    }

    batch.push(parsed);

    if (batch.length >= batchSize) {
      await onBatch(batch.splice(0, batch.length));
    }
  }

  if (batch.length > 0) {
    await onBatch(batch.splice(0, batch.length));
  }
}

async function importProductLines() {
  await importJsonLines([path.join(dataDir, "productLines.db")], async (rows) => {
    const values = rows.flatMap((row) => [
      row.productLineId,
      asText(row.productLineName),
      asText(row.productLineUrlName),
      Boolean(row.isDirect),
    ]);

    await pool.query(
      `INSERT INTO product_lines (
        product_line_id,
        product_line_name,
        product_line_url_name,
        is_direct
      ) VALUES ${createValuesPlaceholders(rows.length, 4)}
      ON CONFLICT (product_line_id) DO UPDATE SET
        product_line_name = EXCLUDED.product_line_name,
        product_line_url_name = EXCLUDED.product_line_url_name,
        is_direct = EXCLUDED.is_direct`,
      values,
    );
  });
}

async function importCategorySets() {
  await importJsonLines([path.join(dataDir, "categorySets.db")], async (rows) => {
    const values = rows.flatMap((row) => [
      row.setNameId,
      row.categoryId,
      asText(row.name),
      asText(row.cleanSetName),
      asText(row.urlName),
      row.abbreviation ? asText(row.abbreviation) : null,
      row.releaseDate ?? null,
      Boolean(row.isSupplemental),
      Boolean(row.active),
    ]);

    await pool.query(
      `INSERT INTO category_sets (
        set_name_id,
        category_id,
        name,
        clean_set_name,
        url_name,
        abbreviation,
        release_date,
        is_supplemental,
        active
      ) VALUES ${createValuesPlaceholders(rows.length, 9)}
      ON CONFLICT (set_name_id) DO UPDATE SET
        category_id = EXCLUDED.category_id,
        name = EXCLUDED.name,
        clean_set_name = EXCLUDED.clean_set_name,
        url_name = EXCLUDED.url_name,
        abbreviation = EXCLUDED.abbreviation,
        release_date = EXCLUDED.release_date,
        is_supplemental = EXCLUDED.is_supplemental,
        active = EXCLUDED.active`,
      values,
    );
  });
}

async function importSetProducts() {
  await importJsonLines([path.join(dataDir, "setProducts.db")], async (rows) => {
    const values = rows.flatMap((row) => [
      row.setNameId,
      row.productId,
      asText(row.game),
      asText(row.number),
      asText(row.productName),
      asText(row.rarity),
      asText(row.set),
      asText(row.setAbbrv),
      asText(row.type),
      row.displayName ? asText(row.displayName) : null,
    ]);

    await pool.query(
      `INSERT INTO set_products (
        set_name_id,
        product_id,
        game,
        number,
        product_name,
        rarity,
        set_name,
        set_abbrv,
        type,
        display_name
      ) VALUES ${createValuesPlaceholders(rows.length, 10)}
      ON CONFLICT (product_id) DO UPDATE SET
        set_name_id = EXCLUDED.set_name_id,
        game = EXCLUDED.game,
        number = EXCLUDED.number,
        product_name = EXCLUDED.product_name,
        rarity = EXCLUDED.rarity,
        set_name = EXCLUDED.set_name,
        set_abbrv = EXCLUDED.set_abbrv,
        type = EXCLUDED.type,
        display_name = EXCLUDED.display_name`,
      values,
    );
  });
}

async function importProducts() {
  const productFiles = (await fsPromises.readdir(dataDir))
    .filter((file) => /^products-\d+\.db$/.test(file))
    .sort()
    .map((file) => path.join(dataDir, file));

  await importJsonLines(productFiles, async (rows) => {
    const values = rows.flatMap((row) => [
      asText(row.productTypeName),
      asText(row.rarityName),
      Boolean(row.sealed),
      asText(row.productName),
      row.setId,
      asText(row.setCode),
      row.productId,
      asText(row.setName),
      row.productLineId,
      row.productStatusId,
      asText(row.productLineName),
      JSON.stringify(row.skus ?? []),
      new Date(),
    ]);

    await pool.query(
      `INSERT INTO products (
        product_type_name,
        rarity_name,
        sealed,
        product_name,
        set_id,
        set_code,
        product_id,
        set_name,
        product_line_id,
        product_status_id,
        product_line_name,
        skus_json,
        updated_at
      ) VALUES ${createValuesPlaceholders(rows.length, 13)}
      ON CONFLICT (product_id) DO UPDATE SET
        product_type_name = EXCLUDED.product_type_name,
        rarity_name = EXCLUDED.rarity_name,
        sealed = EXCLUDED.sealed,
        product_name = EXCLUDED.product_name,
        set_id = EXCLUDED.set_id,
        set_code = EXCLUDED.set_code,
        set_name = EXCLUDED.set_name,
        product_line_id = EXCLUDED.product_line_id,
        product_status_id = EXCLUDED.product_status_id,
        product_line_name = EXCLUDED.product_line_name,
        skus_json = EXCLUDED.skus_json,
        updated_at = EXCLUDED.updated_at`,
      values,
    );
  });
}

async function importSkus() {
  const skuFiles = (await fsPromises.readdir(dataDir))
    .filter((file) => /^skus-\d+\.db$/.test(file))
    .sort()
    .map((file) => path.join(dataDir, file));

  for (const filePath of skuFiles) {
    const fileName = path.basename(filePath);
    const productLineId = Number(fileName.match(/^skus-(\d+)\.db$/)?.[1]);

    if (Number.isNaN(productLineId)) {
      continue;
    }

    const sourceCount = await countJsonLines(filePath);
    const existingCountResult = await pool.query(
      `SELECT COUNT(*)::int AS count
      FROM skus
      WHERE product_line_id = $1`,
      [productLineId],
    );
    const existingCount = existingCountResult.rows[0]?.count ?? 0;

    if (existingCount >= sourceCount) {
      console.log(
        `Skipping ${fileName}: ${existingCount}/${sourceCount} rows already present.`,
      );
      continue;
    }

    console.log(
      `Importing ${fileName}: ${existingCount}/${sourceCount} rows already present.`,
    );

    await importJsonLinesFromOffset(filePath, existingCount, async (rows) => {
      const values = rows.flatMap((row) => [
        row.sku,
        asText(row.condition),
        asText(row.variant),
        asText(row.language),
        asText(row.productTypeName),
        asText(row.rarityName),
        Boolean(row.sealed),
        asText(row.productName),
        row.setId,
        asText(row.setCode),
        row.productId,
        asText(row.setName),
        row.productLineId,
        row.productStatusId,
        asText(row.productLineName),
      ]);

      await pool.query(
        `INSERT INTO skus (
          sku,
          condition,
          variant,
          language,
          product_type_name,
          rarity_name,
          sealed,
          product_name,
          set_id,
          set_code,
          product_id,
          set_name,
          product_line_id,
          product_status_id,
          product_line_name
        ) VALUES ${createValuesPlaceholders(rows.length, 15)}
        ON CONFLICT (sku) DO UPDATE SET
          condition = EXCLUDED.condition,
          variant = EXCLUDED.variant,
          language = EXCLUDED.language,
          product_type_name = EXCLUDED.product_type_name,
          rarity_name = EXCLUDED.rarity_name,
          sealed = EXCLUDED.sealed,
          product_name = EXCLUDED.product_name,
          set_id = EXCLUDED.set_id,
          set_code = EXCLUDED.set_code,
          product_id = EXCLUDED.product_id,
          set_name = EXCLUDED.set_name,
          product_line_id = EXCLUDED.product_line_id,
          product_status_id = EXCLUDED.product_status_id,
          product_line_name = EXCLUDED.product_line_name`,
        values,
      );
    });
  }
}

async function importCategoryFilters() {
  await importJsonLines(
    [path.join(dataDir, "categoryFilters.db")],
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.categoryId,
        JSON.stringify(row.variants ?? []),
        JSON.stringify(row.conditions ?? []),
        JSON.stringify(row.languages ?? []),
      ]);

      await pool.query(
        `INSERT INTO category_filters (
          category_id,
          variants,
          conditions,
          languages
        ) VALUES ${createValuesPlaceholders(rows.length, 4)}
        ON CONFLICT (category_id) DO UPDATE SET
          variants = EXCLUDED.variants,
          conditions = EXCLUDED.conditions,
          languages = EXCLUDED.languages`,
        values,
      );
    },
  );
}

async function importPendingInventory() {
  const filePath = path.join(dataDir, "pendingInventory.db");

  if (!fs.existsSync(filePath)) {
    return;
  }

  await importJsonLines([filePath], async (rows) => {
    const values = rows.flatMap((row) => [
      row.sku,
      row.quantity,
      row.productLineId,
      row.setId,
      row.productId,
      row.createdAt ? new Date(row.createdAt) : new Date(),
      row.updatedAt ? new Date(row.updatedAt) : new Date(),
    ]);

    await pool.query(
      `INSERT INTO pending_inventory (
        sku,
        quantity,
        product_line_id,
        set_id,
        product_id,
        created_at,
        updated_at
      ) VALUES ${createValuesPlaceholders(rows.length, 7)}
      ON CONFLICT (sku) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        product_line_id = EXCLUDED.product_line_id,
        set_id = EXCLUDED.set_id,
        product_id = EXCLUDED.product_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      values,
    );
  });
}

async function importHttpConfig() {
  const filePath = path.join(dataDir, "httpConfig.db");

  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = await fsPromises.readFile(filePath, "utf8");
  const config = contents
    .split(/\r?\n/)
    .map(parseLine)
    .find(Boolean);

  if (!config) {
    return;
  }

  await pool.query(
    `INSERT INTO http_config (
      config_key,
      tcg_auth_cookie,
      user_agent,
      domain_configs,
      adaptive_config
    ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    ON CONFLICT (config_key) DO UPDATE SET
      tcg_auth_cookie = EXCLUDED.tcg_auth_cookie,
      user_agent = EXCLUDED.user_agent,
      domain_configs = EXCLUDED.domain_configs,
      adaptive_config = EXCLUDED.adaptive_config`,
    [
      "default",
      asText(config.tcgAuthCookie),
      asText(config.userAgent),
      JSON.stringify(config.domainConfigs ?? {}),
      JSON.stringify(config.adaptiveConfig ?? {}),
    ],
  );
}

async function run() {
  await runMigrations();

  const stages = [
    ["product_lines", importProductLines],
    ["category_sets", importCategorySets],
    ["set_products", importSetProducts],
    ["products", importProducts],
    ["skus", importSkus],
    ["category_filters", importCategoryFilters],
    ["pending_inventory", importPendingInventory],
    ["http_config", importHttpConfig],
  ];

  let started = importStartAt === null;

  if (importStartAt && !stages.some(([stageName]) => stageName === importStartAt)) {
    throw new Error(
      `Unknown IMPORT_START_AT stage "${importStartAt}". Expected one of: ${stages
        .map(([stageName]) => stageName)
        .join(", ")}`,
    );
  }

  for (const [stageName, stageFn] of stages) {
    if (!started) {
      if (stageName !== importStartAt) {
        continue;
      }

      started = true;
    }

    console.log(`Starting import stage: ${stageName}`);
    await stageFn();
    console.log(`Finished import stage: ${stageName}`);
  }
}

run()
  .then(async () => {
    console.log("Database import completed.");
    await pool.end();
  })
  .catch(async (error) => {
    console.error("Database import failed:", error);
    await pool.end();
    process.exitCode = 1;
  });
