import type { EvidenceWindow } from "./slabEvidence";

export type EvidenceSpec =
  | {
      kind: "alt-sales";
      assetId: string;
      window: EvidenceWindow;
      limitPerGrade: number;
    }
  | { kind: "alt-supply"; assetId: string }
  | { kind: "alt-sale-detail"; transactionId: string }
  | {
      kind: "ebay-sales" | "ebay-supply";
      groupKey: string;
      keywords: string;
      window: EvidenceWindow;
      offset: number;
      limit: 10 | 20 | 50;
      timezone: string;
    };
export type RefreshState =
  "queued" | "running" | "idle" | "failed" | "cancelled";
export class EvidenceRefreshError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export const EVIDENCE_TTL_SECONDS: Record<EvidenceSpec["kind"], number> = {
  "alt-sales": 6 * 3600,
  "alt-supply": 15 * 60,
  "alt-sale-detail": 24 * 3600,
  "ebay-sales": 6 * 3600,
  "ebay-supply": 15 * 60,
};
function id(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value))
    throw new EvidenceRefreshError("Provide a valid provider reference.");
  return value;
}
export function evidenceWindow(window: EvidenceWindow): EvidenceWindow {
  for (const date of [window?.from, window?.to]) {
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new EvidenceRefreshError(
        "Provide an explicit evidence date window.",
      );
  }
  if (
    window.from > window.to ||
    Date.parse(window.to) - Date.parse(window.from) > 3660 * 86400000
  )
    throw new EvidenceRefreshError("Evidence window is out of range.");
  return { from: window.from, to: window.to };
}
export function normalizeEvidenceSpec(spec: EvidenceSpec): EvidenceSpec {
  if (!spec || typeof spec !== "object")
    throw new EvidenceRefreshError("Choose an evidence request.");
  switch (spec.kind) {
    case "alt-sales": {
      if (
        !Number.isInteger(spec.limitPerGrade) ||
        spec.limitPerGrade < 1 ||
        spec.limitPerGrade > 16
      )
        throw new EvidenceRefreshError(
          "Alt sales are capped at sixteen observations per grade.",
        );
      return {
        kind: spec.kind,
        assetId: id(spec.assetId),
        window: evidenceWindow(spec.window),
        limitPerGrade: spec.limitPerGrade,
      };
    }
    case "alt-supply":
      return { kind: spec.kind, assetId: id(spec.assetId) };
    case "alt-sale-detail":
      return { kind: spec.kind, transactionId: id(spec.transactionId) };
    case "ebay-sales":
    case "ebay-supply": {
      if (
        typeof spec.groupKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(spec.groupKey) ||
        typeof spec.keywords !== "string" ||
        !spec.keywords.trim() ||
        spec.keywords.length > 500 ||
        /[\x00-\x1f]/.test(spec.keywords) ||
        ![10, 20, 50].includes(spec.limit) ||
        !Number.isInteger(spec.offset) ||
        spec.offset < 0 ||
        spec.offset > 10000 ||
        spec.offset % spec.limit !== 0 ||
        typeof spec.timezone !== "string" ||
        spec.timezone.length > 100
      )
        throw new EvidenceRefreshError(
          "Provide a bounded eBay evidence request.",
        );
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: spec.timezone });
      } catch {
        throw new EvidenceRefreshError("Choose a valid evidence timezone.");
      }
      return {
        kind: spec.kind,
        groupKey: spec.groupKey,
        keywords: spec.keywords.trim().replace(/\s+/g, " "),
        window: evidenceWindow(spec.window),
        offset: spec.offset,
        limit: spec.limit,
        timezone: spec.timezone,
      };
    }
    default:
      throw new EvidenceRefreshError("Choose a supported evidence source.");
  }
}
