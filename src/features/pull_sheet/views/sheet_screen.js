// @ts-check
// SheetScreen (sheet_screen.rs): the filter and the table's sort, over both lists of the sheet's
// items, the picture cards and the table rows. Both are lists of views in the same order with
// the same keys, so a sort orders the rows by a field and the cards to match.
import { ItemCard, ItemRow, rows } from "corten/views";
/** @import { Message, NumberFormat } from "corten" */
/** @import { Holds } from "corten/views" */

/**
 * What the filter and the sort read and update. The markup builds it once,
 * `js::Found { cards, rows, shown, empty, text, number }`, and passes it as one argument.
 * @typedef {object} Found
 * @property {Holds<ItemCard, HTMLDivElement>} cards
 * @property {Holds<ItemRow, HTMLTableSectionElement>} rows
 * @property {HTMLOutputElement} shown
 * @property {HTMLParagraphElement} empty
 * @property {Message<"shown" | "total">} text
 * @property {NumberFormat} number
 */

/**
 * Shows the items whose name, set, number or product line has what was typed, in both lists.
 * @param {HTMLInputElement} input @param {Found} found
 */
export function filter(input, found) {
  const query = input.value.trim().toLocaleLowerCase();
  let shown = 0;
  let total = 0;
  for (const row of rows(found.rows, ItemRow)) {
    row.el.hidden = query !== "" && !row.search.includes(query);
    total += 1;
    if (!row.el.hidden) shown += 1;
  }
  for (const card of rows(found.cards, ItemCard)) card.el.hidden = query !== "" && !card.search.includes(query);
  found.empty.hidden = shown > 0;
  found.shown.value = query === "" ? "" : found.text({ shown: found.number(shown), total: found.number(total) });
  found.shown.hidden = query === "";
}

/**
 * Opens a row's picture in the dialog rather than a new tab.
 * @param {MouseEvent} event @param {HTMLAnchorElement} link @param {HTMLDialogElement} dialog @param {HTMLImageElement} image
 */
export function showPicture(event, link, dialog, image) {
  event.preventDefault();
  image.src = link.href;
  dialog.showModal();
}

/** @typedef {import("../../../../types/app").SortBy} SortBy Generated from `SortBy` in views.rs. */

/** @type {Record<SortBy, (row: ItemRow) => string | number>} */
const FIELDS = {
  product: (row) => row.name,
  number: (row) => row.number,
  set: (row) => row.set,
  condition: (row) => row.condition,
  rarity: (row) => row.rarity,
  quantity: (row) => row.quantity,
  "product-line": (row) => row.product_line,
};

/**
 * Sorts by one column, ascending then descending (text in the page's language's order, numbers
 * as numbers), and puts the cards in the same order as the rows.
 * @param {MouseEvent} event @param {HTMLAnchorElement} link @param {Found} found @param {SortBy} by
 */
export function sortBy(event, link, found, by) {
  const field = FIELDS[by];
  event.preventDefault();
  const th = /** @type {HTMLTableCellElement} */ (link.closest("th"));
  const descending = th.getAttribute("aria-sort") === "ascending";
  for (const other of Array.from(th.parentElement?.children ?? [])) other.removeAttribute("aria-sort");
  th.setAttribute("aria-sort", descending ? "descending" : "ascending");
  const text = new Intl.Collator(document.documentElement.lang || undefined, { numeric: true });
  // Each row's key is read once, not at every comparison.
  const keyed = Array.from(rows(found.rows, ItemRow), (row) => ({ row, key: field(row) }));
  keyed.sort((a, b) =>
    typeof a.key === "number" && typeof b.key === "number" ? a.key - b.key : text.compare(String(a.key), String(b.key)),
  );
  if (descending) keyed.reverse();
  found.rows.append(...keyed.map(({ row }) => row.el));
  const cards = rows(found.cards, ItemCard);
  const ordered = keyed.map(({ row }) => cards.get(ItemRow.key(row.el))?.el).filter((el) => el !== undefined);
  found.cards.append(...ordered);
}
