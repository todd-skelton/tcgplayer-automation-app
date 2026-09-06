import { useRef, useState } from "react";
export type Json<T> = T extends Date
  ? string
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;
export async function slabRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Json<T>> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "The request failed. Try again.");
  return result;
}
export function useSlabAction() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The request failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}
export const words = (value: string) => value.replace(/[-_]/g, " ");
export const amount = (
  value: number | null | undefined,
  currency: string | null = "USD",
) =>
  value == null
    ? "Unknown"
    : `${currency ?? "Unknown currency"} ${value.toFixed(2)}`;
export const optionalNumber = (value: string) =>
  value.trim() === "" ? null : Number(value);

export function defaultResearchWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  const to = `${part("year")}-${part("month")}-${part("day")}`;
  return {
    from: new Date(Date.parse(to) - 365 * 86400000).toISOString().slice(0, 10),
    to,
  };
}
