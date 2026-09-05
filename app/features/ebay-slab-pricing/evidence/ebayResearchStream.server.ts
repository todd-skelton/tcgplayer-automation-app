import { ProviderRequestError } from "../connections/providerRequest.server";

export type ResearchModule = Record<string, unknown> & { _type: string };
const REQUIRED_TYPES = new Set([
  "ResultsHeaderModule",
  "ResearchAggregateModule",
  "SearchResultsModule",
  "ActiveSearchResultsModule",
]);
const fail = () => new ProviderRequestError("invalid-response");

export function researchText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw fail();
  const row = value as Record<string, unknown>;
  if (typeof row.value === "string") return row.value.trim() || null;
  if (!Array.isArray(row.textSpans)) throw fail();
  const text = row.textSpans
    .map((span) => {
      if (!span || typeof span !== "object") throw fail();
      if (span.text === undefined) return "";
      if (typeof span.text !== "string") throw fail();
      return span.text;
    })
    .join("")
    .trim();
  return text || null;
}

/** JSON frames split by blank lines; transport chunks need not align with UTF-8 or frames. */
export function createResearchStream(keywords = "") {
  let buffer = "";
  let bytes = 0;
  let count = 0;
  let emptyState: "sold" | "active" | null = null;
  let pendingNewline: number | null = null;
  let previousWasCR = false;
  let started = false;
  const modules = new Map<string, ResearchModule>();
  function consume(frame: string) {
    if (!frame.trim()) return;
    if (++count > 16) throw fail();
    let module: ResearchModule;
    try {
      module = JSON.parse(frame);
    } catch {
      throw fail();
    }
    if (
      !module ||
      typeof module !== "object" ||
      Array.isArray(module) ||
      typeof module._type !== "string"
    )
      throw fail();
    if (module._type === "PageErrorModule") {
      // eBay sends an ERROR-severity placeholder even in successful sold responses.
      const payload = Object.entries(module).filter(
        ([key]) => !["_type", "severity", "meta", "debugUrl"].includes(key),
      );
      if (
        payload.some(
          ([, value]) =>
            value != null &&
            value !== "" &&
            !(Array.isArray(value) && value.length === 0),
        )
      ) {
        const messages = module.messages;
        const message =
          Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
        const text = researchText(message);
        if (
          module.severity === "WARNING" &&
          keywords &&
          payload.length === 1 &&
          payload[0][0] === "messages" &&
          text === `No sold results found for "${keywords}"`
        )
          emptyState = "sold";
        else if (
          module.severity === "ERROR" &&
          keywords &&
          payload.length === 1 &&
          payload[0][0] === "messages" &&
          text === `No active results found for "${keywords}"`
        )
          emptyState = "active";
        else throw new ProviderRequestError("unavailable");
      }
    }
    if (REQUIRED_TYPES.has(module._type)) {
      if (modules.has(module._type)) throw fail();
      modules.set(module._type, module);
    }
  }
  return {
    push(chunk: string) {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 2 * 1024 * 1024) throw fail();
      let base = buffer.length;
      buffer += chunk;
      // Scan only new characters; flatten the buffered string only at frame boundaries.
      for (let index = 0; index < chunk.length; index++) {
        const char = chunk[index];
        if (!started && !/\s/.test(char)) {
          started = true;
          if (char === "<")
            throw new ProviderRequestError("reconnect-required");
        }
        if (char === "\n") {
          if (pendingNewline === null)
            pendingNewline = base + index - (previousWasCR ? 1 : 0);
          else {
            consume(buffer.slice(0, pendingNewline));
            buffer = chunk.slice(index + 1);
            base = -index - 1;
            pendingNewline = null;
          }
        } else if (char !== " " && char !== "\t" && char !== "\r")
          pendingNewline = null;
        previousWasCR = char === "\r";
      }
    },
    finish() {
      consume(buffer);
      buffer = "";
      const header = modules.get("ResultsHeaderModule");
      const aggregate = modules.get("ResearchAggregateModule");
      if (!header || !aggregate || !Array.isArray(header.tabs)) throw fail();
      const selected = header.tabs.filter(
        (tab) => tab && typeof tab === "object" && tab.active === true,
      );
      if (selected.length !== 1 || !["sold", "active"].includes(selected[0].id))
        throw fail();
      const state = selected[0].id as "sold" | "active";
      const results = modules.get(
        state === "sold" ? "SearchResultsModule" : "ActiveSearchResultsModule",
      );
      if (
        !results ||
        (emptyState === null && !Array.isArray(results.results)) ||
        (Array.isArray(results.results) && results.results.length > 50) ||
        modules.has(
          state === "sold"
            ? "ActiveSearchResultsModule"
            : "SearchResultsModule",
        )
      )
        throw fail();
      if (emptyState !== null) {
        if (
          state !== emptyState ||
          (results.results !== undefined &&
            (!Array.isArray(results.results) ||
              results.results.length !== 0)) ||
          (emptyState === "sold" &&
            aggregate.sections !== undefined &&
            (!Array.isArray(aggregate.sections) ||
              aggregate.sections.length !== 0))
        )
          throw fail();
        if (emptyState === "active") {
          const sections = aggregate.sections;
          if (!Array.isArray(sections)) throw fail();
          const totals = sections
            .flatMap((section) =>
              Array.isArray(section?.dataItems) ? section.dataItems : [],
            )
            .filter(
              (item) => researchText(item.header) === "Total active listings",
            );
          if (totals.length !== 1 || researchText(totals[0].value) !== "0")
            throw fail();
        }
        return {
          state,
          results: { ...results, results: [] },
          aggregate: { ...aggregate, sections: aggregate.sections ?? [] },
          header,
          empty: true,
        };
      }
      return { state, results, aggregate, header, empty: false };
    },
  };
}
