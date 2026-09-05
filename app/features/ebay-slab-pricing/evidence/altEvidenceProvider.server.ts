import {
  ProviderRequestError,
  type createProviderRequest,
} from "../connections/providerRequest.server";
import {
  altCard,
  altGrading as parseGrading,
} from "../identity/altIdentityFields.server";
import type {
  EvidenceWindow,
  Money,
  SaleEvidence,
  SalesEvidenceResult,
  SupplyEvidence,
} from "./slabEvidence";

const TRANSACTIONS = `query AssetMarketTransactions($id: ID!, $marketTransactionFilter: MarketTransactionFilter!) {
  asset(id: $id) { id marketTransactions(marketTransactionFilter: $marketTransactionFilter) {
    id date auctionHouse auctionType price label subjectToChange consolidatedSkippedReason
    attributes { gradeNumber gradingCompany url autograph }
  } }
}`;
const DETAIL = `query SoldListing($id: ID!) { externalTransaction(id: $id) {
  id date auctionHouse auctionName auctionType displayPrice label fees shipping usdAmount currency
  consolidatedSkippedReason subjectToChange
  asset { id name year subject category brand variety attributes { cardNumber } }
  attributes { grade gradingCompany cert url autograph }
} }`;
const SUPPLY = `query AssetDetails($id: ID!) { asset(id: $id) { id activeListings {
  id listPrice state createdAt type expiresAt
  items { id attributes { gradeNumber gradingCompany autograph qualifier } asset { id } }
} } }`;
const MAX_ROWS = 2000;
const MAX_DETAILS = 32;
type ObjectValue = Record<string, unknown>;
const invalid = () => new ProviderRequestError("invalid-response");
function altGrading(...args: Parameters<typeof parseGrading>) {
  try {
    return parseGrading(...args);
  } catch {
    throw invalid();
  }
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as ObjectValue;
}
function text(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) throw invalid();
  return value.trim() || null;
}
function id(value: unknown): string {
  const result = text(value);
  if (!result || !/^[a-zA-Z0-9-]{1,80}$/.test(result)) throw invalid();
  return result;
}
function boolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw invalid();
  return value;
}
function money(value: unknown, currency: string | null): Money | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
  )
    throw invalid();
  const amount = Number(value);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > Number.MAX_SAFE_INTEGER / 100
  )
    throw invalid();
  return { amount, currency };
}
function date(value: unknown): string | null {
  const result = text(value);
  if (result === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    throw invalid();
  return result;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw invalid();
  return value;
}
function data(body: string): ObjectValue {
  let result;
  try {
    result = object(JSON.parse(body));
  } catch {
    throw invalid();
  }
  if (
    Array.isArray(result.errors) &&
    result.errors.some(
      (error) =>
        object(object(error).extensions ?? {}).code === "UNAUTHENTICATED",
    )
  )
    throw new ProviderRequestError("reconnect-required");
  if (
    result.errors !== undefined &&
    (!Array.isArray(result.errors) || result.errors.length)
  )
    throw invalid();
  return object(result.data);
}
function source(
  value: unknown,
): Pick<SaleEvidence, "sourceUrl" | "sourceItemId"> {
  const raw = text(value);
  if (!raw) return { sourceUrl: null, sourceItemId: null };
  try {
    const url = new URL(raw);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return { sourceUrl: null, sourceItemId: null };
    const ebay = /(^|\.)ebay\.com$/i.test(url.hostname);
    return {
      sourceUrl: url.toString(),
      sourceItemId: ebay
        ? (url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)(?:\/|$)/)?.[1] ?? null)
        : null,
    };
  } catch {
    return { sourceUrl: null, sourceItemId: null };
  }
}
function sale(value: unknown, assetId: string, detail = false): SaleEvidence {
  const row = object(value);
  const attributes = row.attributes == null ? {} : object(row.attributes);
  const currency = detail ? (text(row.currency)?.toUpperCase() ?? null) : null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw invalid();
  return {
    provider: "alt",
    providerId: id(row.id),
    assetId,
    ...source(attributes.url),
    sourceReference: text(attributes.url),
    venue: text(row.auctionHouse),
    kind: "transaction",
    date: date(row.date),
    format: text(row.auctionType),
    title: detail ? text(row.auctionName) : null,
    card: null,
    grading: altGrading(attributes, row.label),
    certificateNumber: detail ? text(attributes.cert) : null,
    price: money(detail ? row.displayPrice : row.price, currency),
    convertedPrice: detail ? money(row.usdAmount, "USD") : null,
    shipping: detail ? money(row.shipping, currency) : null,
    fees: detail ? money(row.fees, currency) : null,
    shippingIncluded: null,
    buyerPremiumIncluded: null,
    quantity: null,
    subjectToChange: boolean(row.subjectToChange),
    skippedReason: text(row.consolidatedSkippedReason),
  };
}

export function parseAltSales(
  body: string,
  assetId: string,
  window: EvidenceWindow,
  limitPerGrade: number,
  asOf: string,
): SalesEvidenceResult {
  const asset = object(data(body).asset);
  if (asset.id !== assetId) throw invalid();
  const observations = rows(asset.marketTransactions).map((row) =>
    sale(row, assetId),
  );
  const dates = observations
    .flatMap((row) => (row.date ? [row.date] : []))
    .sort();
  return {
    // Missing dates remain reviewable but cannot establish window coverage.
    sales: observations.filter(
      (row) =>
        row.date === null || (row.date >= window.from && row.date <= window.to),
    ),
    asOf,
    coverage: {
      requestedWindow: window,
      observedWindow: dates.length
        ? { from: dates[0], to: dates[dates.length - 1] }
        : null,
      complete: false,
      reason: "capped-per-grade",
      sourceCount: observations.length,
      limitPerGrade,
    },
  };
}
export function parseAltSaleDetail(
  body: string,
  transactionId: string,
): SaleEvidence | null {
  const result = data(body);
  if (result.externalTransaction === null) return null;
  const row = object(result.externalTransaction);
  if (row.id !== transactionId) throw invalid();
  const asset = object(row.asset);
  const normalized = sale(row, id(asset.id), true);
  try {
    normalized.card = altCard(asset);
  } catch {
    throw invalid();
  }
  return normalized;
}
export function parseAltSupply(
  body: string,
  assetId: string,
): SupplyEvidence[] {
  const asset = object(data(body).asset);
  if (asset.id !== assetId) throw invalid();
  return rows(asset.activeListings).map((value) => {
    const row = object(value);
    return {
      provider: "alt",
      providerId: id(row.id),
      assetId,
      venue: "Alt",
      sourceUrl: null,
      format: text(row.type),
      state: text(row.state),
      price: money(row.listPrice, null),
      priceKind: "unknown",
      shipping: null,
      quantity: null,
      startedAt: text(row.createdAt),
      endsAt: text(row.expiresAt),
      items: rows(row.items).map((value) => {
        const item = object(value);
        return {
          assetId: item.asset == null ? null : id(object(item.asset).id),
          grading: altGrading(
            item.attributes == null ? {} : object(item.attributes),
          ),
        };
      }),
    };
  });
}

/** Create once per valuation run: bounded detail memoization shares that run's cancellation. */
export function createAltEvidenceProvider(
  request: ReturnType<typeof createProviderRequest>,
  options: { signal?: AbortSignal; now?: () => Date } = {},
) {
  const details = new Map<string, Promise<SaleEvidence | null>>();
  const asOf = () => (options.now?.() ?? new Date()).toISOString();
  async function read<T>(
    operation: string,
    query: string,
    variables: object,
    parse: (body: string) => T,
  ): Promise<T> {
    let result: T;
    await request(
      "alt",
      {
        path: `/graphql/${operation}`,
        body: JSON.stringify({ operationName: operation, variables, query }),
      },
      {
        signal: options.signal,
        validate: (body) => {
          result = parse(body);
        },
      },
    );
    return result!;
  }
  return {
    async getSales(
      assetId: string,
      window: EvidenceWindow,
      limitPerGrade = 16,
    ) {
      assetId = id(assetId);
      const from = date(window.from);
      const to = date(window.to);
      if (
        !from ||
        !to ||
        from > to ||
        !Number.isInteger(limitPerGrade) ||
        limitPerGrade < 1 ||
        limitPerGrade > 16
      )
        throw invalid();
      window = { from, to };
      const capturedAt = asOf();
      return read(
        "AssetMarketTransactions",
        TRANSACTIONS,
        {
          id: assetId,
          marketTransactionFilter: {
            allGrades: true,
            showSkipped: true,
            maxTransactionsPerGrade: limitPerGrade,
          },
        },
        (body) =>
          parseAltSales(body, assetId, window, limitPerGrade, capturedAt),
      );
    },
    getSaleDetail(transactionId: string): Promise<SaleEvidence | null> {
      transactionId = id(transactionId);
      if (options.signal?.aborted) throw new ProviderRequestError("cancelled");
      const existing = details.get(transactionId);
      if (existing) return existing;
      if (details.size >= MAX_DETAILS) throw new ProviderRequestError("busy");
      const pending = read(
        "SoldListing",
        DETAIL,
        { id: transactionId },
        (body) => parseAltSaleDetail(body, transactionId),
      );
      details.set(transactionId, pending);
      pending.catch(() => {
        details.delete(transactionId);
      });
      return pending;
    },
    async getSupply(assetId: string) {
      assetId = id(assetId);
      const capturedAt = asOf();
      const listings = await read(
        "AssetDetails",
        SUPPLY,
        { id: assetId },
        (body) => parseAltSupply(body, assetId),
      );
      return {
        listings,
        asOf: capturedAt,
        scope: "alt-only" as const,
        complete: false as const,
      };
    },
  };
}
