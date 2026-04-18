import Papa from "papaparse";
import type { Sku } from "~/shared/data-types/sku";
import { getReleaseYear } from "../components/pullSheetUtils";
import type { PullSheetCsvRow, PullSheetItem } from "../types/pullSheetTypes";
import { mapPullSheetProductLineName } from "./productLineNameMap";

export interface ParsedPullSheetCsv {
  csvText: string;
  orderIds: string[];
  rows: PullSheetCsvRow[];
}

type PullSheetLookupResponse = {
  skuMap?: Record<number, Sku>;
  error?: string;
};

type PullSheetLookupFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  json(): Promise<PullSheetLookupResponse>;
}>;

export function extractPullSheetCsvParts(text: string): {
  csvText: string;
  orderIds: string[];
} {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      csvText: "",
      orderIds: [],
    };
  }

  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  if (!lastLine.startsWith("Orders Contained in Pull Sheet:")) {
    return {
      csvText: trimmed,
      orderIds: [],
    };
  }

  const orderIds = lastLine
    .split(",")
    .slice(1)
    .join(",")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    csvText: lines.slice(0, -1).join("\n").trim(),
    orderIds,
  };
}

function parsePullSheetCsvRows(csvText: string) {
  return Papa.parse<PullSheetCsvRow>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
}

function sanitizeMalformedProductNameQuotes(csvText: string): string {
  return csvText
    .split(/\r?\n/)
    .map((line, lineIndex) => {
      if (lineIndex === 0) {
        return line;
      }

      const match = line.match(
        /^(?<prefix>"(?:[^"]|"")*",")(?<productName>.*)(?<suffix>",(?:"(?:[^"]|"")*")(?:,"(?:[^"]|"")*"){8})$/,
      );

      if (!match?.groups) {
        return line;
      }

      const { prefix, productName, suffix } = match.groups;
      return `${prefix}${productName.replace(/"/g, '""')}${suffix}`;
    })
    .join("\n");
}

export function parsePullSheetCsv(text: string): ParsedPullSheetCsv {
  const { csvText, orderIds } = extractPullSheetCsvParts(text);

  if (!csvText) {
    throw new Error("The pull sheet CSV was empty.");
  }

  let normalizedCsvText = csvText;
  let parseResult = parsePullSheetCsvRows(normalizedCsvText);

  if (parseResult.errors.some((error) => error.code === "InvalidQuotes")) {
    normalizedCsvText = sanitizeMalformedProductNameQuotes(csvText);
    parseResult = parsePullSheetCsvRows(normalizedCsvText);
  }

  if (parseResult.errors.length > 0) {
    const errorMessages = parseResult.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join(", ");
    throw new Error(`CSV parsing errors: ${errorMessages}`);
  }

  const rows = parseResult.data.filter(
    (row) => row.SkuId && row["Product Name"],
  );

  if (rows.length === 0) {
    throw new Error(
      "No valid rows found in CSV. Expected columns: Product Line, Product Name, Condition, SkuId, etc.",
    );
  }

  return {
    csvText: normalizedCsvText,
    orderIds,
    rows,
  };
}

export function buildPullSheetItemsFromRows(
  rows: PullSheetCsvRow[],
  skuMap: Record<number, Sku> = {},
): PullSheetItem[] {
  return rows.map((row) => {
    const skuId = parseInt(row.SkuId, 10);
    const dbSku = skuMap[skuId];

    return {
      skuId,
      productLine: mapPullSheetProductLineName(row["Product Line"]),
      productName: row["Product Name"],
      condition: row.Condition,
      number: row.Number,
      set: row.Set,
      releaseYear: getReleaseYear(row["Set Release Date"]),
      rarity: row.Rarity,
      quantity: parseInt(row.Quantity, 10) || 1,
      orderQuantity: row["Order Quantity"],
      productId: dbSku?.productId,
      productLineId: dbSku?.productLineId,
      variant: dbSku?.variant,
      dbCondition: dbSku?.condition,
      found: !!dbSku,
    };
  });
}

export async function enrichPullSheetItemsFromRows(
  rows: PullSheetCsvRow[],
  fetchImpl: PullSheetLookupFetch = fetch,
): Promise<PullSheetItem[]> {
  const lookupItems = rows.map((row) => ({
    skuId: parseInt(row.SkuId, 10),
    productLineName: mapPullSheetProductLineName(row["Product Line"]),
  }));

  let skuMap: Record<number, Sku> = {};

  try {
    const response = await fetchImpl("/api/pull-sheet-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: lookupItems }),
    });

    if (response.ok) {
      const result = await response.json();
      skuMap = result.skuMap ?? {};
    }
  } catch {
    skuMap = {};
  }

  return buildPullSheetItemsFromRows(rows, skuMap);
}

export async function loadPullSheetItemsFromCsvText(
  text: string,
  fetchImpl: PullSheetLookupFetch = fetch,
): Promise<ParsedPullSheetCsv & { items: PullSheetItem[] }> {
  const parsed = parsePullSheetCsv(text);
  const items = await enrichPullSheetItemsFromRows(parsed.rows, fetchImpl);

  return {
    ...parsed,
    items,
  };
}
