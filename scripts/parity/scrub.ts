// What a recording keeps of the store's orders: TCGplayer's order numbers become aliases made from
// their hash, the same alias each time, so a recorded answer still matches the request that asked
// for it. src/parity_fixture.rs makes the same aliases of the Rust answers, and turns a recorded
// request's aliases back into the dev database's order numbers before sending it.
import { createHash } from "node:crypto";

const ORDER_NUMBER = /\b[0-9A-F]{8}-[0-9A-F]{6}-[0-9A-F]{5}\b/g;

export function orderAlias(orderNumber: string): string {
  return `ORDER-${createHash("sha256").update(orderNumber).digest("hex").slice(0, 12)}`;
}

export function scrubText(text: string): string {
  return text.replace(ORDER_NUMBER, orderAlias);
}

export function scrub<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrubText(key), scrub(entry)])) as T;
  }
  return value;
}
