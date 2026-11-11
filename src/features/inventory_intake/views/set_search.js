// @ts-check
// The set search, as `catalog::search` (catalog.rs) does it on the server: a card number first,
// then a name. A `script!` module that imports nothing, so a test runs the same cases through
// both (`catalog::tests::the_script_searches_a_set_as_the_server_does`).

/**
 * A number without its leading zeros, as JavaScript's `parseInt` reads one: `003` is `3`,
 * `12a` is `12`, and text that starts with no digit is kept as it is (`normalize_part`).
 * @param {string} part
 */
export function normalizePart(part) {
  const trimmed = part.trimStart();
  let sign = "";
  let rest = trimmed;
  if (trimmed.startsWith("-")) {
    sign = "-";
    rest = trimmed.slice(1);
  } else if (trimmed.startsWith("+")) {
    rest = trimmed.slice(1);
  }
  const digits = /^[0-9]*/.exec(rest)?.[0] ?? "";
  if (digits === "") return part;
  const number = digits.replace(/^0+/, "");
  return number === "" ? "0" : sign + number;
}

/**
 * Whether a card number matches a query: without a slash, the part before the field's first
 * slash; with one, every part; each part without its leading zeros (`matches_number`).
 * @param {string} query @param {string} field
 */
export function matchesNumber(query, field) {
  const q = query.trim();
  const f = field.trim();
  if (q === "" || f === "") return false;
  if (q.includes("/")) {
    const qs = q.split("/");
    const fs = f.split("/");
    return qs.length === fs.length && qs.every((part, i) => normalizePart(part) === normalizePart(fs[i] ?? ""));
  }
  return normalizePart(q) === normalizePart((f.split("/")[0] ?? "").trim());
}

/**
 * A set's products narrowed to a search, in their order: those whose card number matches when
 * any does, otherwise those whose name has the text, whatever its case (`search`).
 * @template {{ name: string, number: string }} P
 * @param {readonly P[]} products @param {string} query
 * @returns {P[]}
 */
export function search(products, query) {
  const q = query.trim();
  if (q === "") return products.slice();
  const byNumber = products.filter((p) => matchesNumber(q, p.number));
  if (byNumber.length > 0) return byNumber;
  const lower = q.toLowerCase();
  return products.filter((p) => p.name.toLowerCase().includes(lower));
}
