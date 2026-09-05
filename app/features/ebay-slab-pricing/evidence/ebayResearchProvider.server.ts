import {
  ProviderRequestError,
  type createProviderRequest,
} from "../connections/providerRequest.server";
import {
  createResearchStream,
  researchText as display,
  type ResearchModule,
} from "./ebayResearchStream.server";
import type {
  EvidenceWindow,
  Money,
  SaleEvidence,
  SalesEvidenceResult,
  SupplyEvidence,
} from "./slabEvidence";
import type { SlabIdentity } from "../identity/slabIdentity";

type JsonObject = Record<string, unknown>;
export type ResearchQuery = {
  keywords: string;
  window: EvidenceWindow;
  offset?: number;
  limit?: 10 | 20 | 50;
  timezone?: string;
};
type PageInfo = {
  offset: number;
  limit: number;
  nextOffset: number | null;
  partial: boolean;
};
const invalid = () => new ProviderRequestError("invalid-response");
const unknownGrading: SlabIdentity["grading"] = {
  grader: "UNKNOWN",
  encoding: "unknown",
  number: null,
  label: null,
  qualifier: null,
  autograph: null,
};
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as JsonObject;
}
function money(value: unknown, shipping = false): Money | null {
  const text = display(value);
  if (!text || text === "-") return null;
  if (shipping && /^free shipping$/i.test(text))
    return { amount: 0, currency: "USD" };
  const match =
    /^\+?\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(?: shipping)?$/.exec(text);
  if (!match) throw invalid();
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER / 100)
    throw invalid();
  return { amount, currency: "USD" };
}
function count(value: unknown): number | null {
  const text = display(value);
  if (!text || text === "-") return null;
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(text)) throw invalid();
  const number = Number(text.replaceAll(",", ""));
  if (!Number.isSafeInteger(number)) throw invalid();
  return number;
}
function day(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw invalid();
  return value;
}
function humanDate(text: string | null): string | null {
  if (!text || text === "-") return null;
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(
      text,
    );
  if (!match) throw invalid();
  const month =
    [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ].indexOf(match[1]) + 1;
  return day(
    `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`,
  );
}
function sourceDate(value: unknown) {
  return humanDate(display(value));
}
export function researchMidnight(date: string, timezone: string): number {
  const target = Date.parse(day(date));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .map((part) => [part.type, part.value]),
    );
    const shown = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    if (shown === target) return guess;
    guess += target - shown;
  }
  throw invalid();
}
function listing(value: unknown) {
  const row = object(value);
  const listing = object(row.listing);
  const itemId = display(listing.itemId);
  const title = display(listing.title);
  if (!itemId || !/^\d{9,15}$/.test(itemId) || !title) throw invalid();
  const format = Array.isArray(listing.formatList)
    ? listing.formatList.map(display).filter(Boolean).join(", ") || null
    : null;
  return {
    row,
    itemId,
    title,
    extendedTitle: display(listing.extendedTitle),
    format,
    sourceUrl: `https://www.ebay.com/itm/${itemId}`,
  };
}
function sale(value: unknown): SaleEvidence {
  const entry = listing(value);
  const price = object(entry.row.avgsalesprice);
  const shipping =
    entry.row.avgshipping == null
      ? null
      : object(entry.row.avgshipping).avgshipping;
  return {
    provider: "ebayResearch",
    providerId: entry.itemId,
    assetId: null,
    sourceItemId: entry.itemId,
    sourceUrl: entry.sourceUrl,
    sourceReference: entry.sourceUrl,
    venue: "eBay",
    kind: "listing-average",
    date: sourceDate(entry.row.datelastsold),
    format: display(price.format) ?? entry.format,
    title: entry.title,
    extendedTitle: entry.extendedTitle,
    card: null,
    grading: { ...unknownGrading },
    certificateNumber: null,
    price: money(price.avgsalesprice),
    convertedPrice: null,
    shipping: money(shipping, true),
    fees: null,
    shippingIncluded: false,
    buyerPremiumIncluded: null,
    quantity: count(entry.row.itemssold),
    subjectToChange: null,
    skippedReason: null,
  };
}
function supply(value: unknown): SupplyEvidence {
  const entry = listing(value);
  const price = object(entry.row.listingPrice);
  const format = entry.format?.toLowerCase();
  return {
    provider: "ebayResearch",
    providerId: entry.itemId,
    assetId: null,
    venue: "eBay",
    sourceUrl: entry.sourceUrl,
    title: entry.title,
    extendedTitle: entry.extendedTitle,
    format: entry.format,
    state: "ACTIVE",
    price: money(price.listingPrice),
    priceKind:
      format === "auction"
        ? "bid"
        : format === "fixed price" ||
            format === "fixed price, best offer accepted"
          ? "ask"
          : "unknown",
    shipping: money(price.listingShipping, true),
    quantity: null,
    startedAt: sourceDate(entry.row.startDate),
    endsAt: null,
    items: [],
  };
}
function summary(module: ResearchModule) {
  if (!Array.isArray(module.sections)) throw invalid();
  return module.sections.flatMap((section) => {
    const row = object(section);
    if (!Array.isArray(row.dataItems)) throw invalid();
    return row.dataItems.map((value) => {
      const item = object(value);
      return {
        label: display(item.header),
        value: display(item.value),
        description: display(item.tooltip),
      };
    });
  });
}
function pageInfo(
  module: ResearchModule,
  offset: number,
  limit: number,
): PageInfo {
  const pagination = object(module.pagination);
  const next = object(pagination.next).disabled;
  if (
    typeof next !== "boolean" ||
    pagination.currentPageNum !== offset / limit + 1
  )
    throw invalid();
  const pageSize = object(pagination.itemsPerPage).options;
  if (!Array.isArray(pageSize)) throw invalid();
  const selected = pageSize.filter((value) => object(value).selected === true);
  if (selected.length !== 1 || object(selected[0]).value !== String(limit))
    throw invalid();
  const rows = module.results as unknown[];
  if (rows.length > limit || (!next && rows.length === 0)) throw invalid();
  const range = display(pagination.summary)?.match(
    /^Results:\s*([\d,]+)\s*-\s*([\d,]+)$/,
  );
  if (
    !range ||
    Number(range[1].replaceAll(",", "")) !== offset + 1 ||
    Number(range[2].replaceAll(",", "")) !== offset + rows.length
  )
    throw invalid();
  return {
    offset,
    limit,
    nextOffset: next ? null : offset + limit,
    partial: !next && rows.length < limit,
  };
}

export function buildResearchKeywords(
  identity: SlabIdentity,
  broadening: "none" | "omit-set" = "none",
): string {
  // Broadening is explicit and never drops known language, edition, finish, stamp or grading.
  const parts = [
    identity.card.year,
    identity.card.game,
    identity.card.name,
    identity.card.cardNumber,
    broadening === "none" ? identity.card.set : null,
    identity.card.language,
    identity.card.edition,
    identity.card.finish,
    identity.card.stamp,
    identity.grading.grader,
    identity.grading.number === null
      ? identity.grading.encoding
      : String(identity.grading.number),
    identity.grading.grader === "PSA" ? null : identity.grading.label,
    identity.grading.qualifier,
    identity.grading.autograph,
  ];
  return parts.filter(Boolean).join(" ");
}

export function createEbayResearchProvider(
  request: ReturnType<typeof createProviderRequest>,
  options: {
    signal?: AbortSignal;
    maxRequests?: number;
    now?: () => Date;
  } = {},
) {
  let remaining = options.maxRequests ?? 3;
  if (!Number.isInteger(remaining) || remaining < 1 || remaining > 10)
    throw invalid();
  async function read(query: ResearchQuery, tab: "SOLD" | "ACTIVE") {
    const keywords = query.keywords.trim();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const timezone = query.timezone ?? "America/Chicago";
    const from = day(query.window.from);
    const to = day(query.window.to);
    if (
      !keywords ||
      keywords.length > 500 ||
      /[\x00-\x1f]/.test(keywords) ||
      from > to ||
      ![10, 20, 50].includes(limit) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      offset % limit !== 0
    )
      throw invalid();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw invalid();
    }
    if (options.signal?.aborted) throw new ProviderRequestError("cancelled");
    if (remaining === 0) throw new ProviderRequestError("busy");
    remaining--;
    const nextDay = new Date(Date.parse(to) + 86400000)
      .toISOString()
      .slice(0, 10);
    const params = new URLSearchParams({
      marketplace: "EBAY-US",
      keywords,
      dayRange: String(
        Math.max(1, (Date.parse(to) - Date.parse(from)) / 86400000),
      ),
      startDate: String(researchMidnight(from, timezone)),
      endDate: String(researchMidnight(nextDay, timezone) - 1),
      categoryId: "0",
      offset: String(offset),
      limit: String(limit),
      tabName: tab,
      tz: timezone,
    });
    for (const module of ["aggregates", "searchResults", "resultsHeader"])
      params.append("modules", module);
    const stream = createResearchStream(keywords);
    let parsed: ReturnType<typeof stream.finish>;
    let page: PageInfo;
    let aggregates: ReturnType<typeof summary>;
    let observations: SaleEvidence[] | SupplyEvidence[];
    const asOf = (options.now?.() ?? new Date()).toISOString();
    await request(
      "ebayResearch",
      { path: `/sh/research/api/search?${params}` },
      {
        signal: options.signal,
        onText: stream.push,
        validate: () => {
          parsed = stream.finish();
          page = parsed.empty
            ? { offset, limit, nextOffset: null, partial: false }
            : pageInfo(parsed.results, offset, limit);
          aggregates = summary(parsed.aggregate);
          if (parsed.state === "sold") {
            const range = display(parsed.header.dateRange)
              ?.split("–")
              .map((value) => humanDate(value.trim()));
            if (
              !range ||
              range.length !== 2 ||
              range[0] !== from ||
              range[1] !== to
            )
              throw invalid();
          }
          observations =
            parsed.state === "sold"
              ? (parsed.results.results as unknown[]).map(sale)
              : (parsed.results.results as unknown[]).map(supply);
        },
      },
    );
    return {
      state: parsed!.state,
      observations: observations!,
      page: page!,
      summary: aggregates!,
      asOf,
      requestedWindow: { from, to },
      keywords,
    };
  }
  return {
    async getSalesPage(query: ResearchQuery) {
      const result = await read(query, "SOLD");
      if (result.state !== "sold")
        return {
          status: "active-fallback" as const,
          asOf: result.asOf,
          keywords: result.keywords,
        };
      const sales = result.observations as SaleEvidence[];
      const dates = sales.flatMap((row) => (row.date ? [row.date] : [])).sort();
      const coverage: SalesEvidenceResult["coverage"] = {
        requestedWindow: result.requestedWindow,
        observedWindow: dates.length
          ? { from: dates[0], to: dates[dates.length - 1] }
          : null,
        complete: false,
        reason: "paged-search",
        sourceCount: sales.length,
        limitPerGrade: null,
      };
      return {
        status: "sold" as const,
        sales,
        coverage,
        asOf: result.asOf,
        page: result.page,
        summary: result.summary,
        keywords: result.keywords,
      };
    },
    async getSupplyPage(query: ResearchQuery) {
      const result = await read(query, "ACTIVE");
      if (result.state !== "active") throw invalid();
      return {
        status: "active" as const,
        listings: result.observations as SupplyEvidence[],
        asOf: result.asOf,
        page: result.page,
        summary: result.summary,
        scope: "ebay-search" as const,
        complete: false as const,
        keywords: result.keywords,
      };
    },
  };
}
